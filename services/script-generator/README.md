# Script Generator (Phase 9)

Converts ranked test candidates from `services/behavior-engine` into runnable
Playwright API tests under `generated-tests/`. This is the bridge between
"what to test" (mined from real traffic, Phase 7) and "an executable test"
(Phase 11 runs it). It does not invent test intent — every candidate already
carries a persona, a flow of `METHOD endpoint` steps, an `expected_status` per
step, and a flow signature; this service's job is purely mechanical: resolve
runtime IDs, synthesize request bodies, and emit a `.spec.ts` file.

## Why this exists

`services/behavior-engine/data/candidates/test-candidates-*.json` is a list of
ranked, LLM-named flow candidates — JSON, not code. Phase 9 turns each
candidate into a real Playwright test that:

- threads runtime IDs (cart id, customer token, order id, ...) through the
  flow the same way a live client would, never hardcoding a seed-data ID
  (CLAUDE.md §5),
- asserts the **status code** the flow actually observed,
- asserts the **golden response schema** when one exists (Phase 8 oracle,
  ADR 0001) — and degrades to a no-op when it doesn't (bodies-off logging
  means `golden-responses/` starts empty; see below),
- stamps a machine-readable `flow_signature` so the Phase 7 skip gate
  (`services/behavior-engine/src/coverage.ts`, ADR 0002) can read it back on
  the next mining run and skip already-covered flows.

## Pipeline

```
behavior-engine candidates (newest test-candidates-*.json)
  -> load.ts      parse + pick newest file by filename timestamp
  -> dedup.ts     defensive re-pass (collapse identical signature,
                  cluster by >=3-token persona prefix, cap 10/persona)
  -> resolve.ts   build a per-flow RequestPlan: runtime ID threading,
                  OAS-driven body synthesis, auth requirement per step
  -> emit.ts      render the .spec.ts source (imports, setup, per-step
                  blocks, flow_signature stamp)
  -> run.ts       CLI: write files to generated-tests/{guest,customer,
                  admin,edge}/, vendor services/golden/src/ into
                  generated-tests/_golden/, write playwright.config.ts
                  + fixtures/auth.ts, print a run summary
```

Run it with:

```bash
npm run script-generator:install     # one-time
npm run script-generator:generate    # regenerate generated-tests/
```

or directly:

```bash
cd services/script-generator
npx tsx src/run.ts                   # newest candidates file
npx tsx src/run.ts --file path/to/test-candidates-2026-01-01T00-00-00-000Z.json
```

Regeneration is **idempotent and deterministic**: filenames are derived from
a 12-character truncation of the candidate's precomputed `signature` field
(`shortHash`, `run.ts`), not from array index, so re-running the generator on
unchanged candidates overwrites the same files rather than accumulating
duplicates or renumbering existing ones.

## Output layout (`generated-tests/`, repo root)

```
generated-tests/
  guest/<sig12>.spec.ts        persona: guest_shopper
  customer/<sig12>.spec.ts     persona: registered_customer
  admin/<sig12>.spec.ts        persona: admin_operator
  edge/<sig12>.spec.ts         attributes.has_errors === true (any persona)
  _golden/                     vendored copy of services/golden/src/, plus
                                generator-written assert-golden.ts + util.ts
                                (self-contained — no imports reach back out
                                of generated-tests/)
  fixtures/auth.ts             shared adminToken(request) login helper
  playwright.config.ts         testDir ".", JSON + HTML reporters, baseURL
                                from MEDUSA_BASE_URL (default localhost:9000)
  package.json / tsconfig.json / node_modules/   (hand-maintained, NOT
                                written by run.ts — installed once via
                                `npm install` inside generated-tests/)
```

**Routing rule** (`run.ts: folderFor`): there is no `edge` persona. A
candidate routes to `edge/` when `attributes.has_errors === true`,
**regardless of persona** — that overlay check happens before the
persona switch. Otherwise: `guest_shopper` → `guest/`, `registered_customer`
→ `customer/`, `admin_operator` → `admin/`.

`generated-tests/` is gitignored (`generated-tests/*` with the output
directories excluded, plus `.gitkeep`) — it is build output, regenerated from
candidates + the OAS, not hand-edited or committed.

## Request building & data threading (`src/resolve.ts`)

Each step needs three things resolved before it can be emitted: path params,
an auth header, and (for non-GET) a request body.

- **Path params**: a small per-flow `scope` map (cart id, customer/admin
  token, region id, product id, order id, line-item id, payment collection
  id, ...) is threaded across steps. A step's path param is satisfied if
  something already in scope can fill it (either captured from an earlier
  step's response, or pulled from a **standalone resolver** — e.g.
  `GET /store/regions` for `regionId`, `GET /store/orders` for `orderId` when
  no earlier step in *this* flow fragment produced one).
- **Cart bootstrap**: many mined flow fragments start mid-sequence (e.g. a
  fragment beginning at `POST /store/carts/{id}/shipping-methods` with no
  prior `POST /store/carts` in the fragment itself). `standaloneResolverFor`
  treats `cartId` as a legitimate 2-step resolver chain —
  `GET /store/regions` → `POST /store/carts` (with the resolved `region_id`)
  — mirroring the plan's own documented `region → cart → line-item →
  shipping → payment → complete` threading. This is the **only** multi-step
  standalone resolver; it is not a general-purpose "invent any missing
  precondition" mechanism.
- **Auth**: `requireCustomerAuth`/`requireAdminAuth` per step is read off the
  candidate's `attributes.requires_auth` plus endpoint shape; customer flows
  establish a session inline (no shared fixture — token reuse is per-flow) via
  the **full Medusa v2 handshake**: `POST /auth/customer/emailpass/register` →
  `POST /store/customers` → `POST /auth/customer/emailpass` (login). The
  register call alone is **not** enough — its token has an empty `actor_id` and
  is rejected by the `requireCustomerAuth` cart/checkout gate (it authorizes
  *creating* the customer, nothing more); only the post-create **login** token
  carries a resolved `actor_id` the gate accepts. Using the register token
  directly 401s every gated step. Admin flows use the shared
  `fixtures/auth.ts` `adminToken()` helper **unless the flow already contains
  its own** `POST /auth/user/emailpass` step, in which case the fixture call is
  skipped (it would just be immediately overwritten by the flow's own login
  capture). The customer handshake is version-sensitive (Medusa 2.x auth
  shapes vary) — the emitted setup carries a `// VERIFY against live backend`
  marker.
- **Body synthesis** (`synthesizeBody`), in priority order:
  1. observed `request_payload` on the candidate step — never present today
     (bodies-off logging, ADR 0001), but checked first for forward
     compatibility,
  2. OAS-synthesized: the augmented spec's request schema for that operation
     is resolved (`$ref`, `allOf` merge, `oneOf` first-branch) and flattened
     to its **required** fields only; ID-typed fields are filled from the
     runtime `scope` (e.g. `region_id` ← `scope.regionId`), other scalars get
     a deterministic literal (`"test-value"`, `0`, `false`, ...),
  3. empty body, if the operation has no required fields,
  4. **unresolvable** — a required field needs a runtime value nothing in
     scope or any standalone resolver can produce, or is itself a
     non-synthesizable type (array/object). This does **not** silently break
     the spec: the step is emitted as `test.fixme(true, "TODO: ...")` with
     the specific missing field named, and the flow plan's `errors[]` is
     surfaced in the `run.ts` summary as a **generation error** — visible,
     not swallowed.
- **Edge derivation**: when a step's own `expected_status >= 400` (this step
  *is* the logged failure), required fields that would normally be
  unresolvable are instead **omitted** rather than failed — this reproduces
  the OAS-required-field-missing condition the traffic actually hit, without
  inventing a new malformation. This only applies to that step's own
  observed failure, not to upstream steps in the same flow.

## `assertGolden` (`generated-tests/_golden/assert-golden.ts`)

`services/golden/src/compare.ts` exports `compareResponse(golden, status,
body)`, not a test-ready assertion. `run.ts` vendors `services/golden/src/`
verbatim into `generated-tests/_golden/` and additionally writes a new
`assert-golden.ts` (not present in the source service) that wraps it:

```ts
export async function assertGolden(endpoint: string, liveStatus: number, liveBody: unknown): Promise<void>
```

It looks up a matching `GoldenResponse` by `(endpoint, expected_status)` in
`golden-responses/` (repo root). **`golden-responses/` is empty on a clean
checkout by design** — bodies-off production logging means Phase 6 ingestion
+ Phase 8 golden generation haven't had bodies-on data to build goldens from
yet. `assertGolden` no-ops (returns without asserting) when no golden exists
for that endpoint+status, and only calls `compareResponse` + `expect()` when
one does. It never throws on a missing golden.

## Vendoring (`run.ts: vendorGoldenComparator`)

`generated-tests/_golden/` is fully self-contained: every run, `run.ts`
deletes and recreates it from `services/golden/src/`, then writes
`assert-golden.ts` and `util.ts` (`extractPath`, `safeJson` — small runtime
helpers used by every emitted spec) alongside the vendored files. No emitted
spec or vendored file imports anything outside `generated-tests/` except the
`golden-responses/` directory lookup inside `assert-golden.ts` itself.

## Defensive dedup (`src/dedup.ts`)

`behavior-engine` already dedupes within its own run. This is a **second,
independent pass** at generation time (candidates files can be hand-edited or
come from an older run), reusing the same primitives
(`behavior-engine/src/signature.ts`'s `canonicalTokens`/`flowSignature`) and
the same algorithm as `behavior-engine/src/dedup.ts`:

1. collapse candidates with an identical flow signature,
2. cluster remaining candidates by a >=3-token canonical-prefix match within
   the same persona, keeping the highest-priority representative,
3. cap at 10 surviving candidates per persona.

It is not a second "is this the same flow?" heuristic — it is the same
signature-based identity check applied again, defensively.

## Hard gates

```bash
cd services/script-generator && npx tsc --noEmit     # must be clean
npm run script-generator:generate                     # >=5 specs, >1 persona
cd generated-tests && npx playwright test --list      # must list all specs
npm run check:phase9                                   # full gate, see below
```

`npm run check:phase9` (`scripts/check-phase9.mjs`) verifies, in order:
generator `tsc --noEmit` clean, a generation run exits 0, >=5 specs across
multiple persona folders, every spec's `flow_signature` stamp matches
`behavior-engine/src/coverage.ts`'s skip-gate regex exactly, no hardcoded
seed-ID literal values, every `edge/` spec asserts a 4xx/5xx status,
`generated-tests/` itself type-checks and lists cleanly under Playwright, and
`_golden/` is self-contained.

## Known, accepted generation errors

On the current candidates corpus, three `registered_customer` flow fragments
reach `POST /store/payment-collections/{id}/payment-sessions` without ever
including a `POST /store/payment-collections` step in the mined fragment, and
Medusa has no standalone `GET /store/payment-collections` to look one up.
Unlike the cart bootstrap above, this is **not** special-cased with an
invented bootstrap chain — doing so would require fabricating a `cart_id`
context the mined fragment never established, which oversteps "what to test
comes from logs." These three are reported as generation errors in the run
summary and the corresponding step is emitted as `test.fixme`.

## Non-goals

- No browser automation — these are API-level Playwright tests using the
  `request` fixture, not page-driven tests.
- No persona inference — persona comes from the candidate
  (`candidate.persona`, a Phase 7 output); this service never re-derives it.
- No invented edge cases — `edge/` specs reproduce an **observed** non-2xx
  step from the mined flow; nothing here synthesizes a new failure mode.
