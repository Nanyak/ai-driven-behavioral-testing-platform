# Phase 10 — Test Execution

## Goal

Run the generated Playwright tests against a running Medusa instance, capture machine-readable and human-readable results, and make persona-scoped runs easy (so a regression can be attributed to guest vs. customer vs. admin).

## Location

```
services/test-runner/
  src/
    run.ts               # wraps playwright test, selects projects/folders
    collect.ts           # parse Playwright JSON -> normalized run result
    cli.ts               # subcommands: all / guest / customer / admin / edge
  package.json
generated-tests/
  playwright.config.ts   # one project per suite folder (3 personas + edge error-path track)
reports/
  playwright/            # raw Playwright HTML + JSON output
```

## Implementation steps

1. **Playwright projects.** In `playwright.config.ts`, define one project per suite folder (`guest`, `customer`, `admin`, `edge`) so they can be run independently via `--project`. Note: `guest`/`customer`/`admin` are personas; `edge` is the error-path track (not a persona) — see Phase 9 plan step 3.
2. **Runner wrapper (`run.ts`).** Shell out to `playwright test` with the chosen project(s); pass base URL and credentials via env; force JSON + HTML reporters.
3. **CLI subcommands:**
   - `npm run test:all`
   - `npm run test:guest`
   - `npm run test:customer`
   - `npm run test:admin`
   - `npm run test:edge`
4. **Collect (`collect.ts`).** Parse Playwright's JSON reporter output into a normalized structure keyed by persona → flow → step, capturing expected vs. actual status, golden diff (surfaced from the imported Phase 8 comparator via test annotations/attachments), duration, and the source `session_id`/`trace_id` carried in the test metadata. This normalized object is the input to Phase 11 reporting.
5. **Failure clarity.** Ensure assertion failures print expected vs. actual status and a readable golden diff, not a raw object dump.

## Carrying provenance into results

Each generated test embeds the originating `flow_name`, `persona`, and `source_sessions` as Playwright `test.info().annotations` (stamped by Phase 9's `emit.ts`; the `source_sessions` array is JSON-stringified into the annotation `description`). `collect.ts` lifts these into the run result so the Phase 11 report can cite where each test came from. Provenance **travels with the test** — it is read back out of the Playwright JSON reporter, never reconstructed from the candidates file.

### `trace_id` is OPTIONAL and absent today (audit decision)

`trace_id` does **not** exist upstream. Behavior-engine candidates carry `source_sessions` (an array of `session_id`s) but **no** `trace_id`, and a candidate step is only `{ method, endpoint, expected_status }`. The normalized result type therefore makes `trace_id?: string | null` — it is emitted **only** if an annotation ever supplies one and is **never invented**. On the current corpus no spec stamps a `trace_id` annotation, so the field is simply omitted from every normalized test.

Consequence for Phase 11: the Phase 11 plan's required-field "Include source `trace_id`" (and the checklist item of the same name) must be read as **"include `trace_id` when present; otherwise omit"** — `source_session_id`/`source_sessions` is the always-present provenance key, `trace_id` is best-effort. The Phase 11 report builder must not require a `trace_id` on every failure.

### Step granularity via `test.step()`

Per-step results (the `persona → flow → step` keying this plan asks for) come from Phase 9 wrapping each emitted request+assertions block in `test.step("<METHOD endpoint>", ...)`. Playwright's JSON reporter then carries a `steps[]` array per test result, each step titled `"<METHOD> <endpoint>"`. `collect.ts` matches those titles (`/^(GET|POST|...)\s+(\/\S+)$/`), reads each step's `error.message` (a failing `expect(resp.status()).toBe(n)` embeds `Expected: <n>` / `Received: <n>`, which we parse into expected-vs-actual status), and attaches the `golden-diff` JSON attachment lifted from the test result. A step with no `error` is `passed`.

## Known findings from the first live run

Running `npm run test:all` against local Medusa surfaced four distinct failure
classes (these are *findings*, not test-runner bugs):

- **A. Auth-credential synthesis (fixed in Phase 9).** In-flow `/auth/*/emailpass` login steps were emitting empty/junk bodies → `401`. Fixed by threading real credentials (see Phase 9 plan, "Payload synthesis" step 2).
- **B. Missing required query params (fixed in Phase 9).** `GET /store/shipping-options` / `GET /store/payment-providers` were emitted without their OAS-required `cart_id` / `region_id` → `400`. Fixed by OAS-driven required-query synthesis (see Phase 9 plan, "Required query params").
- **C. Customer-account gate (open finding — SUT policy, NOT fixed).** The system-under-test enforces a custom middleware (`apps/medusa/apps/backend/src/api/gate-contract.ts`): *"Require an authenticated customer JWT for all cart and checkout mutations."* Guest cart creation/mutation returns `401`, and a freshly-registered customer token has no `customer_id` until a `POST /store/customers` profile is created, so even customer-auth cart bootstraps are gated. Consequence: every mined **guest cart flow** and any cart/order flow that does not perform the full register→create-customer handshake fails at `POST /store/carts`. This is the platform **correctly flagging that the test corpus contains flows the current SUT policy forbids** — a real drift signal for HITL review (Phase 16), not something to paper over with a hacked assertion. Resolution belongs to a corpus regenerate against current traffic and/or a fuller customer-auth bootstrap, deferred by decision.

Net live result after A+B: failures dropped from 19→12 and are now **monocausal** (all Class C); admin suite is fully green.

## Key decisions

- **Suite = Playwright project** → trivial scoped runs and per-suite pass/fail counts. The four projects (`guest`, `customer`, `admin`, `edge`) are defined in the **generated** `generated-tests/playwright.config.ts` by the Phase 9 generator (`script-generator/src/run.ts: writeConfigAndFixtures`), not by hand-editing — a regeneration would clobber a hand edit. Three projects map to a persona; `edge` is the error-path track (not a persona). The runner selects one with `--project <suite>` (or all projects for `all`).
- **JSON is the contract** between execution and reporting; HTML is for humans. Both land under `reports/playwright/` (the generated config's reporter output paths read `PLAYWRIGHT_JSON_OUTPUT` / `PLAYWRIGHT_HTML_OUTPUT`, which `run.ts` sets); the normalized run result is written alongside as `reports/playwright/normalized.json`.
- **Provenance travels with the test**, not reconstructed later.
- **`trace_id` is optional and never invented** — see the provenance section above.

## Validation / acceptance

- `npm run test:all` executes the generated suite against local Medusa.
- Per-persona subcommands run only their folder.
- Playwright JSON and HTML outputs land under `reports/playwright/`.
- A deliberately failing assertion is reported clearly (expected vs. actual).
- Normalized run result includes persona, flow, endpoint, expected/actual status, golden diff, duration, and source session/trace IDs.
