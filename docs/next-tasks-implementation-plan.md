# Implementation plan — remaining 6 regression failures

> Baseline: `run-2026-06-23-165517` — **15/21 passed, 6 failed**. The guest-auth and
> line-items-add issues are already fixed (see `catalog-pollution-breaks-checkout` memory).
> These 6 are distinct, pre-existing issues. Each root cause below was confirmed live against
> the running Medusa SUT (`localhost:9000`). All file paths are under
> `services/script-generator/src/` unless noted.

## The 6 failures, grouped

| # | Endpoint | Persona | Live error | Group |
|---|----------|---------|-----------|-------|
| 1 | `POST /admin/orders/{id}/cancel` | admin | "Order … has been canceled." | A (order state) |
| 2 | `POST /admin/orders/{id}/fulfillments` | admin | "Order … has been canceled." | A (order state) |
| 3 | `POST /admin/returns` | admin | "Order id not found: test-order_id" | B (body fidelity) |
| 4 | `POST /admin/products` | admin | "Product options are not provided for: [test-title]" | B (body fidelity) |
| 5 | `POST /store/carts/{id}/line-items/{id}` | customer | "Field 'quantity' is required" | C (param/normalization) |
| 6 | `GET /store/customers/me` (exp 401, got 200) | customer | broken-token flow runs with a valid token | D (negative-auth) |

Cross-cutting cause for #1–#4: the generated tests **resolve a shared, arbitrary resource**
(`orders[0].id`) or **synthesize placeholder bodies** from an OAS whose schema is insufficient.

---

## Task A — State-aware admin order resolution (fixes #1, #2)

**Root cause.** `standaloneResolverFor("orderId", ADMIN)` (`resolve.ts`) emits
`GET /admin/orders → orders[0].id`, which returns an arbitrary order — in the failing run, an
**already-canceled** one. Cancel then 400s ("has been canceled") and fulfillment 400s (a
canceled order can't be fulfilled). Both failures referenced the same canceled order id.

**Live findings.**
- `GET /admin/orders?status[]=pending&order=-created_at` works and returns non-canceled orders
  (status values seen: `pending`, `canceled`, `completed`; `fulfillment_status` filter is IGNORED
  on this build — do not rely on it).
- On a `pending` order: `cancel` → 200, and `fulfillment` (with `items[].id` + `quantity`) → 200,
  when the order has items and no existing fulfillment.

**Fix.** In `standaloneResolverFor`, change the ADMIN `orderId` branch endpoint to
`"/admin/orders?status[]=pending&order=-created_at"` (a literal query string — `resolveUrlExpr`
returns it via `JSON.stringify`, which Playwright accepts). Extract stays `orders[0].id`.

**Fulfillment item ids.** The fulfillment flow already fetches `GET /admin/orders/{id}` and
`captureRulesFor` binds `lineItemId = order.items[0].id` (landed in the working diff). With a
pending order that has items, `synthesizeBody` for `/fulfillments` threads `items:[{id, quantity}]`
+ `location_id` (already wired). No further change expected — verify after Task A.

**Residual risk (note, don't over-engineer).** Multiple admin tests resolving `orders[0]` can race
on the same order (the first cancel removes it from the `pending` set, so re-resolution self-heals,
but parallel workers could still collide). If flaky, set the test-runner Playwright `workers: 1` for
admin, or have the resolver pick a random offset. Acceptable to ship with the simple filter first.

**Files:** `resolve.ts` (`standaloneResolverFor` orderId ADMIN branch).
**Verify:** regenerate; `npm run test:admin`; cancel + fulfillment flows green.
**Effort:** low.

---

## Task B — Admin composite bodies (fixes #3 returns, #4 products)

The OAS schemas for both endpoints are `$ref`/`allOf`-heavy and the generic synthesizer can't
produce a valid composite body (it emits placeholder strings). Mirror the **known-good bodies**
from the traffic generator (`services/traffic-generator/src/api/admin-session.ts`) via a
special-case in `synthesizeBody` (same pattern as the existing `authCredentialBody`).

### B1 — `POST /admin/returns` (#3)
**Root cause.** Synth emits `order_id: "test-order_id"` (placeholder) → 404 "Order id not found".
**Live findings.** `POST /admin/returns {order_id:<pending order>, location_id:<stock loc>}` → 200.
**Fix (recommended — special-case body):**
```ts
// in synthesizeBody, before generic synth:
if (method === "POST" && endpoint === "/admin/returns") {
  return { kind: "synthesized", fields: {
    order_id: { kind: "runtime", ref: "orderId" },
    location_id: { kind: "runtime", ref: "stockLocationId" },
  }};
}
```
The flow already resolves `orderId` (its `GET /admin/orders/{id}` step) — with Task A that's a
pending order — and `stockLocationId` has a resolver (landed in the diff).
**Lighter alternative:** add `order_id: "orderId"` to `ID_FIELD_TO_SCOPE` so the generic synth
threads it; only works if the OAS marks `order_id` required AND `location_id` isn't needed — the
special-case is safer.

### B2 — `POST /admin/products` (#4)
**Root cause.** Synth emits `{ title: "test-title" }` only → "Product options are not provided"
(a variant must reference the product's declared options; price/sales-channel also needed).
**Fix (special-case body, mirroring `admin-session.ts` `createProduct`):**
```ts
if (method === "POST" && endpoint === "/admin/products") {
  return { kind: "synthesized", fields: {
    title: { kind: "raw", expr: "`GEN-${Date.now()}`" },
    status: { kind: "literal", value: "published" },
    shipping_profile_id: { kind: "runtime", ref: "shippingProfileId" },
    options: { kind: "raw", expr: `[{ title: "Size", values: ["One Size"] }]` },
    variants: { kind: "raw", expr: '[{ title: "Default", sku: `GEN-${Date.now()}`, options: { Size: "One Size" }, prices: [{ amount: 1500, currency_code: "eur" }] }]' },
    sales_channels: { kind: "raw", expr: "[{ id: scope.salesChannelId }]" },
  }};
}
```
**Supporting resolvers/captures needed** (the flow already has the `GET /admin/shipping-profiles`
and `GET /admin/sales-channels` steps, so add capture rules; or add standalone resolvers):
- `captureRulesFor`: `GET /admin/shipping-profiles → { shippingProfileId: "shipping_profiles[0].id" }`,
  `GET /admin/sales-channels → { salesChannelId: "sales_channels[0].id" }`.
- `standaloneResolverFor`: add `shippingProfileId` (`GET /admin/shipping-profiles`) and
  `salesChannelId` (`GET /admin/sales-channels`) for flows that lack the GET step.
- `scopeVarForParam` is not involved (these are body refs, not path params).

`currency_code: "eur"` matches the seed's single European region — keep hardcoded (document the
assumption); SKU/title use `Date.now()` for uniqueness across reruns.

**Files:** `resolve.ts` (`synthesizeBody` special-cases; `captureRulesFor`; `standaloneResolverFor`).
**Verify:** `npm run test:admin`; returns + products flows green.
**Effort:** returns low; products medium (composite body).

---

## Task C — `POST /store/carts/{id}/line-items/{id}` update (fixes #5)

**Root cause (two bugs, one origin).** The OAS path is `/store/carts/{id}/line-items/{line_id}`
(distinct param names), but `log-ingestion/src/pipeline.ts` `normalizeSegment` replaces EVERY
id-like segment with the same `{id}` placeholder, producing the candidate token
`/store/carts/{id}/line-items/{id}`. Consequences:
1. `requestSchemaFor` looks up `doc.paths["/store/carts/{id}/line-items/{id}"]` → miss (the OAS key
   is `…/{line_id}`) → empty body → live error "Field 'quantity' is required" (the OAS marks
   `quantity` required).
2. Both path params share the name `id` → `pathParamNames` returns `["id","id"]`, `pathParams` keys
   collide, both map to `cartId`, and the second `{id}` is emitted **unsubstituted** in the URL.

This is the ONLY store path with ≥2 path params, so a **targeted fix is sufficient** (a general
structural OAS-path matcher is the heavier alternative — see below).

**Fix (targeted, in `resolve.ts` + `emit.ts`):**
1. **Schema lookup alias.** In `requestSchemaFor` (or a small pre-map), alias
   `/store/carts/{id}/line-items/{id}` → `/store/carts/{id}/line-items/{line_id}` so the update
   body schema (with required `quantity`) is found → synth emits `quantity: 1`.
2. **Positional path params.** Handle duplicate-named params positionally: first `{id}` on a
   `/store/carts/…` path → `cartId`, the `{id}` AFTER `line-items` → `lineItemId`. This needs
   `pathParamNames` + the path-substitution in `emit.ts urlExpr` to work by position/occurrence,
   not by a name-keyed map (today a duplicate name overwrites). Substitute the 2nd occurrence with
   `${scope.lineItemId}`.
3. **`lineItemId` resolver + capture (Medusa v2 shape).** v2 `POST …/line-items` returns `{ cart }`,
   not `{ line_item }`:
   - Fix `captureRulesFor("POST","/store/carts/{id}/line-items")` → `{ lineItemId: "cart.items[0].id" }`
     (currently `line_item.id`, which silently fails the best-effort capture).
   - Add `standaloneResolverFor("lineItemId")` = `[ ...cartId bootstrap (seeds an item), { GET
     /store/carts/{cartId} → extract "cart.items[0].id" } ]` so an update step that needs a line
     item id can resolve one even when no prior add step captured it.

**Heavier alternative (do NOT do for one endpoint):** fix `normalizeSegment` to emit distinct
placeholders (e.g. derive from the preceding segment) AND realign the golden OAS param names — this
changes signature/dedup hashes for the whole corpus and forces a full re-mine. Only worth it if more
multi-param endpoints appear later.

**Files:** `resolve.ts` (`requestSchemaFor` alias, `scopeVarForParam` positional, `captureRulesFor`,
`standaloneResolverFor`), `emit.ts` (`urlExpr` positional substitution).
**Verify:** the "Mid-Cart Checkout Completion" customer flow; the update step asserts 200.
**Effort:** medium (path-param positional handling is the fiddly part).

---

## Task D — Broken-token negative auth (fixes #6)

**Root cause.** Flow "Customer Registration with Broken Token Carry-Through" asserts
`GET /store/customers/me → 401` (a register-only / broken token can't read the profile), but the
generator's always-on customer handshake (`emit.ts` `autoRegister` setup) establishes a VALID
session token → the step returns 200.

**Fix (per-step auth downgrade for negative auth assertions).** In `authFor` / `buildFlowPlan`:
when a step targets an auth-gated endpoint AND its `expected_status === 401`, emit that single step
**without** the `Authorization` header (auth `publishable-key`/`none`). The `requireCustomerAuth`
gate / customer-account guard then returns 401, reproducing the assertion by status (the mechanism
differs — no-token vs broken-token — but the status-only regression assertion holds). Guard narrowly
(auth-gated endpoint + expected 401) so other steps are unaffected; the setup still establishes the
token for any non-negative steps in the same flow.

**Fallback.** If per-step auth proves messy, suppress these low-value broken-token flows in
`selection/dedup.ts` (or a generation skip) rather than emitting an unsatisfiable assertion.

**Files:** `resolve.ts` (`authFor` / per-step auth in `buildFlowPlan`).
**Verify:** the customers/me step asserts 401 and passes.
**Effort:** low.

---

## Regenerate & verify (every task)

Pipeline order and gotchas (from the `catalog-pollution-breaks-checkout` memory):
1. The catalog is already repaired; only re-run traffic if you changed the traffic generator.
2. `data/sessions/*.json` is written by `ingest:run` (reads ES), and ingest defaults to a **24h
   window that mixes old runs**. If you re-run traffic, ingest with `-- --from <ISO>` scoped to the
   new run's 5-minute spike (find it via an ES `date_histogram`).
3. The behavior-engine **skip gate** treats existing specs as "already covered". For a full regen,
   `rm generated-tests/{admin,customer,guest,edge}/*.spec.ts` first (keep `_golden/`, `fixtures/`,
   configs), then re-mine.
4. Run: `npm run behavior:mine → npm run script-generator:generate → npm run test:all`.
   (Tasks A–D are pure script-generator/resolver changes; you only need
   `script-generator:generate → test:all` unless you also re-mine.)

**Per-task green checks** (read `reports/report.json` `endpoint_failures`):
- A: `POST /admin/orders/{id}/cancel` and `…/fulfillments` gone.
- B: `POST /admin/returns` and `POST /admin/products` gone.
- C: `POST /store/carts/{id}/line-items/{id}` gone.
- D: `GET /store/customers/me` gone.
Target: **21/21 green** (admin worker-serialization may be needed for A's race).

## Suggested order (independent unless noted)
1. **D** (low risk, isolated) → 2. **A** (enables B1) → 3. **B1 returns** → 4. **B2 products** →
5. **C** (most fiddly). Commit per task so a regression is easy to bisect.
