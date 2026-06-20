# Test Runner (Phase 10)

Executes the Phase 9 generated Playwright suite (`generated-tests/`) against a
running Medusa instance, captures machine-readable + human-readable results, and
normalizes the Playwright JSON into a **persona → flow → step** run result that
is the input to Phase 11 reporting.

This service does not generate tests (that is Phase 9) or render stakeholder
reports (that is Phase 11). Its job is purely execution + normalization.

## Commands

From the repo root (delegate to this service's CLI):

```bash
npm run test:all        # run every persona project
npm run test:guest      # run only generated-tests/guest/   (--project guest)
npm run test:customer   # run only generated-tests/customer/
npm run test:admin      # run only generated-tests/admin/
npm run test:edge       # run only generated-tests/edge/
```

Or directly:

```bash
cd services/test-runner
npx tsx src/cli.ts guest        # all | guest | customer | admin | edge
```

## Persona = Playwright project

The four projects (`guest`, `customer`, `admin`, `edge`) are defined in the
**generated** `generated-tests/playwright.config.ts`, written by the Phase 9
generator (`services/script-generator/src/run.ts: writeConfigAndFixtures`).
**Do not hand-edit that config** — regenerating the suite clobbers it. The runner
selects a project with `--project <persona>`; `all` runs them all.

## Env contract

The runner passes these through to the generated suite + `fixtures/auth.ts`
(filling sane defaults under whatever is already in the environment):

| Var | Default | Used by |
| --- | --- | --- |
| `MEDUSA_BASE_URL` | `http://localhost:9000` | playwright `baseURL` |
| `MEDUSA_PUBLISHABLE_KEY` | `""` | every store-side request header |
| `MEDUSA_ADMIN_EMAIL` | `admin@medusa-test.com` | `fixtures/auth.ts` admin login |
| `MEDUSA_ADMIN_PASSWORD` | `supersecret` | `fixtures/auth.ts` admin login |

Set a real `MEDUSA_PUBLISHABLE_KEY` for store flows to succeed — without it,
`GET /store/regions` (and every other store call) returns 400.

## Output (`reports/playwright/`, repo root)

```
reports/playwright/
  results.json      raw Playwright JSON reporter output
  html/             raw Playwright HTML report (open html/index.html)
  normalized.json   collect.ts output — the Phase 11 input
```

Reporter output paths are wired in the generated config via
`PLAYWRIGHT_JSON_OUTPUT` / `PLAYWRIGHT_HTML_OUTPUT`, which `run.ts` sets. The
`reports/` tree is gitignored build output.

## Modules

- `src/cli.ts` — subcommand dispatch (`all | guest | customer | admin | edge`),
  runs Playwright, normalizes, writes `normalized.json`, prints a summary +
  readable failures, exits with Playwright's status.
- `src/run.ts` — shells out to `playwright test` in `generated-tests/`, scoping
  with `--project`, setting the env + reporter output paths. Lets the generated
  config's configured JSON+HTML reporters handle output (does **not** override
  with `--reporter`, which would drop the configured `outputFile`).
- `src/collect.ts` — parses the Playwright JSON into `NormalizedRunResult`
  (exported; the Phase 11 contract). Lifts `persona` / `flow_name` /
  `source_sessions` / `flow_signature` from the annotations Phase 9 stamps, the
  golden schema diff from the `golden-diff` attachment, and expected-vs-actual
  status from each step's `expect` error. Counts passed/failed/skipped
  (≈20 specs are `test.fixme` and report as skipped).
- `src/failure.ts` — renders a failure as expected-vs-actual status + a readable
  golden diff (plan §5), not a raw object dump.

## Normalized result shape (the Phase 11 contract)

```ts
interface NormalizedRunResult {
  generated_at: string;
  totals: { executed; passed; failed; skipped };
  tests: NormalizedTest[];
}
interface NormalizedTest {
  persona; flow_name; flow_signature; source_sessions: string[];
  trace_id?: string | null;     // OPTIONAL — absent upstream, never invented
  project; file; title; status; duration_ms;
  steps: NormalizedStep[];      // { endpoint, method, expected_status,
                                //   actual_status, status, duration_ms,
                                //   golden_diff, failure_message }
}
```

### `trace_id` is optional and absent today

Behavior-engine candidates carry `source_sessions` but **no** `trace_id`, and a
step is only `{ method, endpoint, expected_status }`. `trace_id` is therefore
typed `trace_id?: string | null` and emitted only if a `trace_id` annotation
ever supplies one — it is **never invented**. On the current corpus the field is
omitted from every normalized test. See `docs/phase-10-implementation-plan.md`
and the Phase 11 checklist note.

## Hard gates

```bash
cd services/test-runner && npx tsc --noEmit     # must be clean
npm run check:phase10                            # full gate, see below
```

`npm run check:phase10` (`scripts/check-phase10.mjs`) verifies: test-runner
`tsc --noEmit` clean, the generated config defines all four suite projects
(guest/customer/admin personas + edge error-path track),
`playwright test --list --project <suite>` works for each, `collect.ts`
correctly normalizes a committed sample Playwright JSON fixture
(`fixtures/sample-playwright-report.json` — totals, expected/actual status,
golden-diff lift, source_sessions lift, trace_id omission), and a **live**
`test:edge` run when Medusa `:9000/health` is reachable (**gracefully skipped**,
not failed, when the backend is down).
