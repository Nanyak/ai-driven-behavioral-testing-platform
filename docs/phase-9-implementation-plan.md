# Phase 9 — Script Generator

## Goal

Convert ranked test candidates from the behavior engine into runnable Playwright API tests (`.spec.ts`), one canonical test per selected flow, with runtime-resolved IDs, auth handling, status assertions, and golden-schema assertions.

> Framework note: the problem statement mentions Jest/Mocha; this project standardizes on Playwright's `request` context for API testing (plan §12). One runner, one report format.

> HITL scope: the HITL Review Dashboard phase (plan §16) operates on **flows and generated tests** — browse, approve, discard. Persona is **not** a control there; it is the read-only label carried over from Phase 7's emergent classification, used only to group/filter the test list. The MVP version is read-only; step editing and execution gating are optional extensions. See the "HITL scope" section in the Phase 7 plan.

## Location

```
services/script-generator/
  src/
    load.ts              # read behavior-engine candidates
    dedup.ts             # second-pass dedup/cluster/cap (defensive)
    templates/
      store-flow.ts.hbs  # guest/customer store-side test template
      admin-flow.ts.hbs  # admin test template
      edge-flow.ts.hbs   # edge-case (expect 4xx) template
    resolve.ts           # runtime ID/token resolution helpers emitted into tests
    emit.ts              # render templates -> .spec.ts files
    run.ts               # CLI entrypoint
generated-tests/
  guest/  customer/  admin/  edge/
  _golden/               # vendored copy of services/golden comparator (self-contained suite)
  playwright.config.ts
  fixtures/auth.ts       # shared admin login / publishable key fixtures
```

## Implementation steps

1. **Load candidates** from `services/behavior-engine/data/candidates/`.
2. **Defensive dedup** (candidates are already deduped in Phase 7, but re-apply): identical step sequences → highest support; common-prefix ≥3 → longest representative; cap 10 per persona. Use the **same canonical flow signature** as Phase 7 (`behavior-engine/src/signature.ts`, ADR 0002) — do not define a second "same flow?" key here.
3. **Per-flow generation.** One `.spec.ts` per canonical flow, grouped into four **suite** folders: `guest/ customer/ admin/` map to the emergent persona (`guest_shopper`, `registered_customer`, `admin_operator`), and `edge/` is an **error-path track**, not a persona — any flow with `attributes.has_errors` routes there regardless of persona (its true persona is preserved in the test annotation). Persona and track are orthogonal axes; `edge/` is the one bucket keyed on outcome rather than identity.
   - **Filename is derived from the flow signature**, not a sequential index: `<persona>/<short-hash>.spec.ts` where `<short-hash>` is a truncation of the signature. This makes regeneration **idempotent** — re-emitting a flow that already exists writes the same path, so it is a no-op rather than a duplicate or a blind overwrite, and filename collisions are meaningful (same signature = same flow).
   - **Stamp the flow signature into each test** as a Playwright annotation / header comment (e.g. `test.info().annotations` or a `// flow-signature: <hash>` header). This makes the generated-tests corpus **self-describing**, so the Phase 7 cross-run skip gate (`coverage.ts`, ADR 0002) can rebuild its coverage manifest by reading signatures back out of the emitted `.spec.ts` files.
   - **Stamp full provenance, not just the signature** (added for Phase 10). Each spec also pushes `persona`, `flow_name`, and `source_sessions` as `test.info().annotations`, with the `source_sessions` array JSON-stringified into the annotation `description` (an annotation description is a single string). Provenance thus **travels with the test**: Phase 10's `collect.ts` lifts persona/flow/source-sessions straight out of the Playwright JSON reporter rather than reconstructing them from the candidates file. There is **no** `trace_id` annotation — candidates carry `source_sessions` but no trace id, and one is never invented (see the Phase 10 plan). `session_id` provenance is a debugging/reporting tag only, never a Phase 7 classifier signal (CLAUDE.md §8.2).
   - **Wrap each emitted step in `test.step("<METHOD endpoint>", ...)`** (added for Phase 10). Each request+assertions block is wrapped so the Playwright JSON reporter carries **per-step** results, letting Phase 10 key results persona→flow→step. The flow-level `scope`, `publishableKey`, and captured ids are declared **outside** the steps (in the test body) so they thread across step boundaries unchanged. `test.fixme(...)` stays at the test level (it skips the whole test), so a fixme step is emitted unwrapped.
4. **Runtime resolution** (never hardcode seeded IDs):
   - product/variant IDs ← `GET /store/products` at test start
   - cart ID ← captured from `POST /store/carts` response
   - line-item ID ← captured from add-item response
   - customer token ← register/login within the test (customer flows)
   - admin token ← shared fixture `fixtures/auth.ts`
   - publishable key ← `process.env.MEDUSA_PUBLISHABLE_KEY`
5. **Assertions per step:**
   - status code assertion from candidate `expected_status`
   - golden-schema assertion via the Phase 8 `compare` utility (imported into the test) for steps that have a stored golden. The vendored `assert-golden.ts` wrapper (written by `run.ts: vendorGoldenComparator`) **attaches the schema diff** as a `golden-diff` JSON attachment via `test.info().attach(...)` on **both pass and fail** (before the `expect`), so Phase 10's `collect.ts` can surface the diff for every golden-asserted step, not only failing ones. The no-golden case stays a no-op (it neither attaches nor asserts).
   - edge-case templates assert the expected 4xx/5xx
6. **Request bodies** follow the payload policy in *Request building & data threading* (below): observed `request_payload` when present (bodies-on runs), else a minimal valid body synthesized from the OpenAPI request schema (Phase 8), else an empty body — **never a guessed body**.
7. **Vendor the comparator.** Copy the Phase 8 golden comparator from the canonical `services/golden/src/` into `generated-tests/_golden/` on each generation run, so the suite is self-contained with no reach-back dependency on `services/`. Because the copy is regenerated every run, it never drifts from the source.
8. **Playwright config**: base URL from env, sensible timeouts, JSON + HTML reporters wired (consumed in Phase 10/11).

## Request building & data threading (the hard part)

The example below chains cart → line-item, but a real customer checkout threads
`region → cart → line-item → shipping → payment → complete`. The generator turns a
mined step sequence into a dependency chain explicitly; this section is the contract
for how each step's inputs are produced.

### Payload synthesis (bodies-off safe)

Production logs run **bodies-off** (ADR 0001), so `request_payload` is usually
absent. Body resolution, in priority order:

1. **Observed** — use the candidate's `request_payload` verbatim if present (bodies-on enrichment run).
2. **Auth credentials** — the `/auth/*/emailpass[/register]` login endpoints are **not** in the store/admin OAS, so schema synthesis would yield an empty (credential-less) body and the login would `401`. These emit **real, threaded** credentials instead: admin login (`POST /auth/user/emailpass`) reads the same `MEDUSA_ADMIN_EMAIL`/`MEDUSA_ADMIN_PASSWORD` env the shared fixture uses; customer register/login (`POST /auth/customer/emailpass[/register]`) reuse the in-test generated `email`/`password` consts, so a later login matches the registration. The emit setup declares those consts whenever the flow carries any customer-auth step and auto-registers **only** when the flow has no register step of its own (avoiding a duplicate-email double-register).
3. **Synthesized** — build a minimal body from the operation's OpenAPI **request** schema (the OAS is already loaded in Phase 8): include **required** fields only, fill ID-typed fields (`variant_id`, `region_id`, `option_id`, `provider_id`) with runtime-resolved values and other scalars with deterministic literals (`quantity: 1`).
4. **Empty** — operations with no request body.

A step whose body can be **neither** observed nor synthesized from the OAS (no
schema, no log) emits a `test.fixme(...)` with a TODO rather than a guessed body —
surfaced in the generation run summary, not silently shipped.

### Required query params (OAS-driven)

Some GETs require a query param the OAS marks `required` (`GET /store/shipping-options`
needs `cart_id`; `GET /store/payment-providers` needs `region_id`). The generator
reads the operation's `in: query, required: true` parameters and fills **ID-typed**
ones (`cart_id`, `region_id`, …) from runtime scope, resolving a missing value via a
standalone GET/bootstrap the same way path-param IDs are resolved (a `regionId` comes
from `GET /store/regions`; a `cartId` from the region→cart bootstrap). A required
ID-typed query param that no prior step or standalone GET can produce is a reported
generation error (→ `test.fixme`), never a request shipped with the param omitted —
unless the step's own `expected_status` is already a 4xx (then the omission *is* the
reproduced edge condition). Non-ID required query params are left untouched (no guessed value).

### Step → request-builder resolution table

| Step (method + endpoint) | Path/ID input | Body input | Resolved from |
| --- | --- | --- | --- |
| `GET /store/regions` | — | — | publishable key |
| `POST /store/carts` | — | `region_id` | region from `GET /store/regions` |
| `POST /store/carts/{id}/line-items` | cart id (prev resp) | `variant_id`, `quantity` | variant from `GET /store/products`; `quantity:1` |
| `POST /store/carts/{id}/shipping-methods` | cart id | `option_id` | `GET /store/shipping-options?cart_id=` |
| `POST /store/payment-collections` → `/payment-sessions` | cart id | `provider_id` | `GET /store/payment-providers` |
| `POST /store/carts/{id}/complete` | cart id | — | — |
| customer auth (`/auth/customer/emailpass[/register]`) | — | email/password | generated in-test, captured token |
| `POST /admin/*` | per call (runtime IDs) | per OAS schema | admin fixture token |

### Data threading

The generator walks the canonical flow **in order**; for each step it emits, in
sequence: (a) any resolve calls for inputs not already in scope, (b) the request,
(c) the assertions — capturing into scope every ID a later step needs (cart id →
shipping → payment → complete). A step that needs an input **no prior step produced
and that no standalone GET can resolve** is a generation error reported in the run
summary, not a silently broken `.spec.ts`.

### Edge-case (4xx) derivation

An edge candidate carries the **observed** failing status + endpoint from the logs
(status is logged even bodies-off). The edge template reproduces the **logged**
failure condition — it never invents a new malformation:

- missing required field → the observed `400` (e.g. `line-items` with no `variant_id`);
- unauthenticated cart mutation → the observed `401` from the auth gate;
- when the malformed body itself isn't recoverable (bodies-off), assert the status from the reproducible **structural** condition (omit the auth header, or omit an OAS-required field) that deterministically yields it.

## Example emitted test (shape)

```ts
import { test, expect } from "@playwright/test";
import { assertGolden } from "../_golden/compare";

test("guest_shopper — create cart and add item", async ({ request }) => {
  const key = process.env.MEDUSA_PUBLISHABLE_KEY!;
  const products = await request.get("/store/products", { headers: { "x-publishable-api-key": key } });
  expect(products.status()).toBe(200);
  const variantId = (await products.json()).products[0].variants[0].id;

  const cart = await request.post("/store/carts", { headers: { "x-publishable-api-key": key } });
  expect(cart.status()).toBe(200);
  const cartId = (await cart.json()).cart.id;
  await assertGolden("POST /store/carts", 200, await cart.json());

  const add = await request.post(`/store/carts/${cartId}/line-items`, {
    headers: { "x-publishable-api-key": key },
    data: { variant_id: variantId, quantity: 1 },
  });
  expect(add.status()).toBe(200);
});
```

## Key decisions

- **One test per canonical flow** — clustering already happened upstream; the generator should not re-expand.
- **Signature-keyed, idempotent emission (ADR 0002)** — filenames derive from the canonical flow signature and each test stamps that signature on itself, so regeneration is a no-op for already-covered flows and the corpus feeds Phase 7's cross-run skip gate.
- **All IDs resolved at runtime** — tests must survive a reseed.
- **Golden comparator is vendored, not reached-back-to** — `services/golden` stays the single source of truth, but it is copied into `generated-tests/_golden/` each run so the generated suite is self-contained and portable.

## Validation / acceptance

- ≥5 `.spec.ts` files generated across personas.
- Generated files type-check / `playwright test --list` succeeds (syntactically valid, discoverable).
- `generated-tests/` is self-contained: tests import the comparator from `_golden/`, not from `services/`.
- Each test resolves its own IDs and tokens; no hardcoded seed IDs.
- Each test has at least a status assertion; store/admin flows also carry golden-schema assertions.
- Edge tests assert the expected error status, reproducing the **logged** failure condition (not an invented one).
- No step ships a guessed body: every request body is observed, OAS-synthesized, empty, or a flagged `test.fixme`.
- Multi-step flows thread runtime IDs through the chain; an unresolvable step input is a reported generation error, not a broken spec.
