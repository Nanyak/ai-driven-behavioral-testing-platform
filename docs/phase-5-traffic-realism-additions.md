# Phase 5 — Traffic-Realism Additions (developer implementation plan)

Adds four high-value behavior themes to the synthetic traffic generator so the
log stream (and therefore the Phase 7 discovery / Phase 9 tests) covers user and
admin journeys that today generate **zero traffic**. Scope is grounded in a live
capability probe of *this* minimal Medusa 2.15.5 build — not Shopee. Anything the
backend cannot actually do is listed under **Out of scope** and must not be faked.

> Read first: `docs/phase-5-implementation-plan.md` (taxonomy, stages, floors),
> `services/traffic-generator/README.md`, and `CLAUDE.md` §5 (traffic-generator
> rules). Every new session type MUST be wired in **all** of: `SESSION_TYPES`,
> `STAGE_OF`, `Weights`, both profile weight objects, `identityFor`,
> `IDENTITY_SPLIT` (if identity isn't fixed), and the `dispatch` switch. A missing
> entry is a silent drop or a TS error.

## Backend facts (verified live, do not re-assume)
1 region (`eur`), 12 products, 4 product-categories, **0 collections**, 57
inventory items with `manage_inventory:true` / `allow_backorder:false`, a real
Inventory module + one stock location (`European Warehouse`), **1 payment provider**
(`pp_system_default`). Seed: `apps/medusa/apps/backend/src/migration-scripts/initial-data-seed.ts`.

## Out of scope (the minimal app cannot represent these — do not model them)
- **Collections** (`/store/collections` → count 0; workflow imported but never called). Drop collection-based discovery unless someone first adds `createCollectionsWorkflow` to the seed.
- **Payment-method / COD choice** (only `pp_system_default` exists). There is no second method to choose between — drop the "method split" idea entirely.
- **Customer-initiated return / cancel** — admin-only by decision (ADR 0003). Unchanged.
- **Wishlist, reviews/ratings, seller chat, OTP/social login** — not in Medusa core; out of scope.

## Cross-cutting prerequisite — fix the auth-wall retry (do this first)
`services/traffic-generator/src/noise.ts:37` blind-retries **any** 4xx, including a
401 auth wall, producing the unrealistic `POST /store/carts 401 ×N` storm. Make the
retry **status-aware**: do not retry on `401`/`403` (auth failures are not
input-correction retries). Keep retry for 400/404/409/422.

```ts
// noise.ts runSteps()
if (noise.retry && !res.ok && res.status >= 400 && res.status < 500
    && res.status !== 401 && res.status !== 403) {
  await step();
}
```

This is required by Theme 1 and removes a junk negative-flow candidate from Phase 7.

---

## Theme 1 — Guest → sign-in conversion

**Real behavior:** a logged-out shopper tries to add to cart, hits the gate, signs
in, and continues (or abandons at the wall). This is the guest→customer transition
Phase 7's "highest-privilege attribute reached" rule (§10.3) is built to classify —
currently the data never produces it cleanly.

**Hard constraint:** the scripted conversion uses **login of a pooled account**,
never `register`. Register→checkout in one session is the **holdout** and stays
LLM-only in `personas/customer-llm.ts` (CLAUDE.md §5, hard constraint #5). A scripted
flow that emits both `register` and `complete` is a violation.

**New flow** `flows/conversion.ts` → `runCartWallConversion(client, account, intent)`
where `intent ∈ {convertBuy, convertAbandon, wallBounce}`:
- `loadRegions()` → `browseProducts()` → `viewProduct()` *(guest, no token — role null)*
- **the wall:** one `createCart()` attempt with no token → **401** (single attempt; the noise fix above prevents a retry storm)
- `wallBounce`: stop here — a guest session carrying a single `has_errors` 401 (real "hit the wall, left").
- otherwise `loginExisting(account.email, account.password)` *(now customer)* → `createCart()` 200 → `addItem()` 200
- `convertBuy`: `ensureCheckoutReady()` → `complete()` → `viewOrder()`
- `convertAbandon`: stop after add.

Emits `role_observed:[guest,customer]` with a 401→auth→200 pivot — the exact discovery target.

**Wiring:** new session type `cartWallConversion`, Stage 1. `identityFor` → `returning`
(it logs in). Dispatch picks the intent (e.g. 55% convertBuy / 30% convertAbandon /
15% wallBounce). Weights: realistic **6**, signal-rich **10**.

**Acceptance:** ≥1 session shows `… 401 on POST /store/carts → login → 200 on POST /store/carts → complete`; `wallBounce` sessions end with a guest 401 and no login.

---

## Theme 2 — Catalog discovery (categories + pagination + sort + search)

**Real behavior:** category-led browsing with sort and "load more", the dominant
browse pattern. Whole query-param families are currently untested.

**New `StoreSession` methods** (`api/store-session.ts`), all read-only, guest or returning:
- `listCategories()` → `GET /store/product-categories` (returns 4 `pcat_*`).
- `browseByCategory(categoryId)` → `GET /store/products?category_id[]=<id>`.
- `browsePage(offset, limit)` → `GET /store/products?limit=<l>&offset=<o>` (12 products ⇒ ≥3 pages at limit 5).
- `sortProducts(order)` → `GET /store/products?order=<order>` with `order ∈ {title,-title,created_at,-created_at}`.
- (search `?q=` already exists via `searchProducts`.)

**New flow** `flows/category-browse.ts` → `runCategoryBrowse(client, account|null)`:
`loadRegions()` → `listCategories()` → pick one → `browseByCategory()` → `sortProducts()`
→ `browsePage(offset=limit)` *(page 2)* → `viewProduct()` ×2–4. ~20% apply a category+sort combo, ~30% paginate a second page.

Optional low-effort bonus: sprinkle `sortProducts`/`browsePage` into existing `browse`
and `comparisonBrowse` (extra endpoint coverage, no new type).

**Wiring:** session type `categoryBrowse`, Stage 1. `IDENTITY_SPLIT` `{ guest: 80, returning: 20 }`. Weights: realistic **10**, signal-rich **12**.

**Acceptance:** sessions exercise `product-categories`, `?category_id[]=`, `?order=`, and `?offset=` (verify they appear as distinct normalized endpoints/params in the logs). **Do not** add any collection calls.

---

## Theme 3 — Inventory theme: admin create-product + restock, customer stock-out

One coherent arc (the seller's core loop + the most realistic checkout failure). All
three endpoints verified working live.

**New `AdminSession` methods** (`api/admin-session.ts`):
- `createProduct({ lowStock? })` → `GET /admin/shipping-profiles?limit=1` for `shipping_profile_id`, then `POST /admin/products` with min body:
  ```json
  { "title": "...", "status": "published", "shipping_profile_id": "sp_...",
    "options": [{ "title": "Size", "values": ["One Size"] }],
    "variants": [{ "title": "Default", "sku": "...", "options": { "Size": "One Size" },
                   "prices": [{ "amount": 1500, "currency_code": "eur" }] }] }
  ```
  Resolve the created variant id + its inventory item + location from the response / `GET /admin/inventory-items`. **No hardcoded ids** (CLAUDE.md §5).
- `setInventoryLevel(inventoryItemId, locationId, qty)` → `POST /admin/inventory-items/{id}/location-levels/{location_id}` `{ "stocked_quantity": qty }`.

**Orchestration (Stage 0, runs once):** admin creates a dedicated **limited-stock**
product (e.g. stock 4) so stock-out is deterministic *without* contaminating the 12
seeded products. Store `lowStockVariantId` in `RunState`. Using a dedicated product
avoids breaking unrelated sessions' adds.

**New `StoreSession` capability + flow** `flows/stockout.ts` → `runStockOutCheckout(client, account, lowStockVariantId)`:
`loadRegions()` → `loginExisting()` → `viewProduct(lowStockVariantId's product)` →
`createCart()` → `addItem(variant=lowStockVariant, quantity=stock+1)` → **400**
`insufficient_inventory` → then either abandon, or `addItem(quantity=1)` → 200
(recover) → optionally `complete()`.

**`adminCatalog` enhancement (plan §8.5 alignment):** add a `chance(0.4) createProduct()`
branch to `flows/admin.ts` `runAdminFlow` so `POST /admin/products` (listed in the
plan but never implemented) is exercised on the normal catalog path too.

**Wiring:** new customer session type `stockOutCheckout`, Stage 1, `identityFor` →
`returning`. Weights: realistic **3**, signal-rich **5**. `RunState` gains
`lowStockVariantId?: string`. If the pool isn't seeded (e.g. create-product 4xx),
`stockOutCheckout` degrades to a normal returning browse — do **not** hard-fail.

**Acceptance:** ≥1 `400 insufficient_inventory` on `POST /store/carts/{id}/line-items`; `POST /admin/products` and `POST /admin/inventory-items/{id}/location-levels/{id}` both appear with 2xx in the logs.

---

## Theme 4 — Promo failures + admin return-rejection (payment split dropped)

**4a. Invalid promo code (already partially present — confirm + sharpen).** The agent
confirmed `POST /store/carts/{id}/promotions { "promo_codes": ["DOES_NOT_EXIST"] }`
→ **400**. Verify `StoreSession.applyPromoCode` uses this endpoint/shape and that the
existing `promoAttempt × promoInvalid` path produces a clean, countable 400. No new
type — it rides on cart/checkout flows.

**4b. Min-spend not met (new, low priority — silent no-op, NOT an error).** Seed a
min-spend promo in Stage 0:
`POST /admin/promotions` with the existing working order-level shape **plus**
`rules:[{ "attribute":"item_total", "operator":"gte", "values":["100"] }]`. Applying
that code to an under-threshold cart returns **200 with `promotions:[]`,
`discount_total:0`** — model it as an "applied, no discount" outcome on a small cart
(a new `EventProbs.minSpendFail` ~0.1 on cart flows). It produces no 4xx, so it is a
realism/behavior signal, not a negative-test signal.

> Resolve the stale `// VERIFY` in `admin-session.ts` `createPromotion` (≈ lines
> 87–104): the existing order-level promo body **works (200)** on this build — the
> "POST /admin/promotions 400" project note is stale. Update the comment + the
> Phase 5 checklist line accordingly.

**4c. Admin return-rejection (new).** A third reversal archetype next to refund (F3)
and cancel (F5): the operator **rejects** a requested return instead of refunding it.
- New `AdminSession.cancelReturn(returnId, items)` → `POST /admin/returns/{id}/cancel` `{ "items": [{ "id": <return_item_id>, "quantity": 1 }] }` on a return in **`requested`** state (empty/over-quantity bodies 400 — scope the items correctly).
- New flow `runAdminReturnReject(client, …, orderId)`: reuse `beginReturn → requestReturnItems → confirmReturnRequest` (return now `requested`) → `cancelReturn(...)` instead of receive/refund.
- **Wiring:** new session type `adminReturnReject`, Stage 2b (needs a pooled order). Weights: realistic **1**, signal-rich **3**. Reuses the `returnPool`; degrade-or-skip if empty (Stage 2 empty-order-pool hard-fail rule still applies to the wave, per CLAUDE.md hard constraint #3 — follow the existing F3 pattern).

**Optional / stretch — expired promo.** `ends_at` is rejected on the promotion;
expiry is campaign-gated: `POST /admin/campaigns` with a past `ends_at`, attach the
promo via `campaign_id`, then verify apply-time behavior (400 vs silent) before
modeling. Defer unless time permits.

**Acceptance:** ≥1 invalid-promo 400; ≥1 admin `POST /admin/returns/{id}/cancel` 2xx linked to a pooled order; payment-method/COD code path **absent**.

---

## Config & wiring summary (concrete)

`config.ts`:
- `Weights` interface + `REALISTIC_WEIGHTS` + `SIGNAL_RICH_WEIGHTS`: add
  `cartWallConversion` (6 / 10), `categoryBrowse` (10 / 12), `stockOutCheckout`
  (3 / 5), `adminReturnReject` (1 / 3).
- `EventProbs`: add `minSpendFail` (~0.1) for Theme 4b.
- `Floors`: no new **mandatory** floors (keeps existing acceptance gates stable). If
  signal-rich coverage of the new negatives matters, add soft floors for
  `stockOuts` and `returnRejects` there only.

`taxonomy.ts`: add the four types to `SESSION_TYPES`; `STAGE_OF`
(`cartWallConversion`/`categoryBrowse`/`stockOutCheckout` → 1, `adminReturnReject` →
2); `identityFor` (`cartWallConversion`,`stockOutCheckout` → returning;
`adminReturnReject` → guest/admin axis); `IDENTITY_SPLIT` (`categoryBrowse`
`{guest:80,returning:20}`).

`dispatch.ts`: a `case` per new type calling its flow; `cartWallConversion` and
`stockOutCheckout` draw a pooled account; `stockOutCheckout` reads
`state.lowStockVariantId`; `adminReturnReject` draws from `returnPool`.

`state.ts` (`RunState`): add `lowStockVariantId?: string` (Theme 3) and, if doing 4b,
`minSpendPromoCode?: string`.

Orchestrator (`run.ts`): Stage 0 creates the limited-stock product + min-spend promo;
Stage 2b includes the `adminReturnReject` wave. Print the new types in the
observed-vs-target table and add their acceptance lines.

## Definition of done
- `cd services/traffic-generator && npx tsc --noEmit` clean (hard gate, CLAUDE.md §3).
- `npm run check:phase5` passes; the observed-vs-target table lists all four new types with non-zero realized counts on `signal-rich`.
- A run produces, at minimum: one 401→login→200 conversion, one `insufficient_inventory` 400, one `POST /admin/products` 2xx, one `POST /admin/returns/{id}/cancel` 2xx, and one invalid-promo 400.
- Docs updated in the same change: this file's status, `docs/phase-5-implementation-plan.md` (new leaves in the taxonomy), and `services/traffic-generator/README.md` (session-type list). Resolve the stale promo `VERIFY` note.
- After landing, regenerate the ~1k validation corpus (the agreed validation pass) so Phase 7 sees the new flows.

## Suggested sequencing (small PRs)
1. **noise.ts retry fix + Theme 1** (conversion) — unblocks the mismodel, smallest blast radius.
2. **Theme 2** (catalog discovery) — pure read-only additions.
3. **Theme 3** (inventory arc) — admin create/restock + customer stock-out (most new surface area).
4. **Theme 4** (promo failures + return-reject) — reuses the existing reversal/promo machinery.

---

# Developer task breakdown (execution checklist)

Four PRs, in order. Each PR is independently shippable, ends green on
`cd services/traffic-generator && npx tsc --noEmit` and `npm run check:phase5`, and
updates docs in the same change. Tasks name the file and the exact change. Tick as you go.

## PR 1 — Auth-wall fix + guest→sign-in conversion *(implemented)*
- [x] **T1.1** `src/noise.ts` `runSteps`: add `&& res.status !== 401 && res.status !== 403` to the retry guard (no blind-retry on auth walls).
- [x] **T1.2** New `src/flows/conversion.ts` → `runCartWallConversion(client, account, intent)` with `intent ∈ {convertBuy, convertAbandon, wallBounce}`. Sequence: guest `loadRegions → browseProducts → viewProduct` → one `createCart()` (expect 401) → `wallBounce` returns here; else `loginExisting` → `createCart` (200) → `addItem` → `convertBuy` runs `ensureCheckoutReady → complete → viewOrder`, `convertAbandon` stops. **Never call `register` here** (holdout rule).
- [x] **T1.3** `src/config.ts`: add `cartWallConversion` to `Weights`, `REALISTIC_WEIGHTS` (`6`), `SIGNAL_RICH_WEIGHTS` (`10`).
- [x] **T1.4** `src/taxonomy.ts`: add to `SESSION_TYPES`; `STAGE_OF.cartWallConversion = 1`; `identityFor` → `returning`.
- [x] **T1.5** `src/dispatch.ts`: `case "cartWallConversion"` — draw a real pooled account (`state.drawAccount()`, so login succeeds), pick intent (~55/30/15), call the flow; pool the order on `convertBuy`.
- [x] **T1.6** Observed-vs-target table auto-iterates `SESSION_TYPES` (no change needed). Acceptance line added in `src/reporting.ts` (`conversionPivots` — counts a `create_cart` 401 followed by a later ok `create_cart`), **not** `run.ts` as originally scoped.
- [x] **T1.7** Verified: `tsc --noEmit` clean; a `MIX_PROFILE=signal-rich` / `TRAFFIC_TOTAL_SESSIONS=300` run realized 22 `cartWallConversion` sessions — 21 `401→login→200` pivots + 1 `wallBounce` ending on a guest 401 (used signal-rich rather than smoke, which is too small to reliably realize a conversion session).
- [x] **T1.8** Docs: `docs/phase-5-implementation-plan.md` taxonomy + `services/traffic-generator/README.md` session-type list.
- [x] **T1.9** *(bug found during PR-1 verification)* `src/api/store-session.ts` `setAddress`/`loadRegions`: resolve `country_code` from the **live region** instead of the hardcoded `"us"`. The seed ships a single European region (`dk,fr,de,it,es,se,gb`), so the old value made `POST /store/carts/{id}` 400 (`"Country with code us is not within region Europe"`) on **every** checkout flow — a systemic spurious error (orders still completed because the mock shipping/payment path doesn't enforce an in-region address). Fixed: `loadRegions` captures the region's first `iso_2`; `setAddress` uses it (fallback `de`). Verified live: `set_address` now 200.

## PR 2 — Catalog discovery (categories + pagination + sort + search)
- [ ] **T2.1** `src/api/store-session.ts`: add `listCategories()` (`GET /store/product-categories`), `browseByCategory(id)` (`?category_id[]=`), `browsePage(offset, limit)` (`?limit=&offset=`), `sortProducts(order)` (`?order=` ∈ `title|-title|created_at|-created_at`). Reuse existing `searchProducts` for `?q=`.
- [ ] **T2.2** New `src/flows/category-browse.ts` → `runCategoryBrowse(client, account|null)`: `loadRegions → listCategories → pick → browseByCategory → sortProducts → browsePage(page 2) → viewProduct ×2–4`.
- [ ] **T2.3** `src/config.ts`: `categoryBrowse` weights `10` / `12`.
- [ ] **T2.4** `src/taxonomy.ts`: `SESSION_TYPES`; `STAGE_OF = 1`; `IDENTITY_SPLIT.categoryBrowse = { guest: 80, returning: 20 }`.
- [ ] **T2.5** `src/dispatch.ts`: `case "categoryBrowse"`.
- [ ] **T2.6** *(optional)* sprinkle `sortProducts`/`browsePage` into existing `browse` / `comparisonBrowse` for extra coverage.
- [ ] **T2.7** Verify: logs contain `product-categories`, `?category_id[]=`, `?order=`, `?offset=`; **no** `/store/collections` calls. `run.ts` table updated.
- [ ] **T2.8** Docs as in T1.8.

## PR 3 — Inventory arc (admin create/restock + customer stock-out)
- [ ] **T3.1** `src/api/admin-session.ts`: `createProduct({ lowStock? })` — `GET /admin/shipping-profiles?limit=1` then `POST /admin/products` (min body in the Theme 3 spec); resolve created variant + inventory item + location from the response / `GET /admin/inventory-items` (no hardcoded ids). `setInventoryLevel(itemId, locationId, qty)` → `POST /admin/inventory-items/{id}/location-levels/{location_id}` `{ stocked_quantity }`.
- [ ] **T3.2** `src/state.ts`: add `lowStockVariantId?: string` to `RunState`.
- [ ] **T3.3** `src/run.ts` Stage 0: admin creates a dedicated limited-stock product (stock ~4), store its variant id in `lowStockVariantId`. If create-product 4xx, log and continue (`lowStockVariantId` stays unset).
- [ ] **T3.4** `src/api/store-session.ts`: ensure `addItem` can target an explicit `variantId` + `quantity` (add params if needed).
- [ ] **T3.5** New `src/flows/stockout.ts` → `runStockOutCheckout(client, account, lowStockVariantId)`: `login → view → createCart → addItem(qty=stock+1)` (expect **400 insufficient_inventory**) → then abandon, or `addItem(qty=1)` (200) → optional `complete`.
- [ ] **T3.6** `src/flows/admin.ts` `runAdminFlow`: add `chance(0.4) createProduct()` (exercises `POST /admin/products` on the normal catalog path; plan §8.5 alignment).
- [ ] **T3.7** `src/config.ts`: `stockOutCheckout` weights `3` / `5`.
- [ ] **T3.8** `src/taxonomy.ts`: `SESSION_TYPES`; `STAGE_OF = 1`; `identityFor` → `returning`.
- [ ] **T3.9** `src/dispatch.ts`: `case "stockOutCheckout"` — draw account; read `state.lowStockVariantId`; if unset, degrade to a normal returning browse (do **not** hard-fail).
- [ ] **T3.10** `src/run.ts`: table + acceptance (`insufficient_inventory` 400; `POST /admin/products` 2xx; `POST /admin/inventory-items/.../location-levels/...` 2xx).
- [ ] **T3.11** Docs as in T1.8.

## PR 4 — Promo failures + admin return-rejection
- [ ] **T4.1** `src/api/admin-session.ts`: resolve the stale `// VERIFY` on `createPromotion` (order-level body **works** on this build). Add `cancelReturn(returnId, items)` → `POST /admin/returns/{id}/cancel` `{ items: [{ id, quantity }] }`.
- [ ] **T4.2** `src/api/store-session.ts`: confirm `applyPromoCode` uses `POST /store/carts/{id}/promotions { promo_codes }` and surfaces the invalid-code **400**. *(4b, optional)* add a min-spend "applied, no discount" path on a small cart.
- [ ] **T4.3** `src/run.ts` Stage 0 *(only if doing 4b)*: seed a min-spend promo (`rules:[{attribute:"item_total",operator:"gte",values:["100"]}]`), store `minSpendPromoCode` in `RunState`.
- [ ] **T4.4** `src/config.ts` *(4b only)*: `EventProbs.minSpendFail ≈ 0.1`.
- [ ] **T4.5** New flow `runAdminReturnReject(client, …, orderId)`: `beginReturn → requestReturnItems → confirmReturnRequest` (state `requested`) → `cancelReturn(...)`.
- [ ] **T4.6** `src/config.ts`: `adminReturnReject` weights `1` / `3`.
- [ ] **T4.7** `src/taxonomy.ts`: `SESSION_TYPES`; `STAGE_OF = 2`; `identityFor` → default (admin axis).
- [ ] **T4.8** `src/dispatch.ts` + `src/run.ts` Stage 2b: `case "adminReturnReject"` draws from `returnPool`; skip/degrade if empty (follow the F3 pattern; Stage-2 empty-pool hard-fail rule still applies to the wave).
- [ ] **T4.9** `src/run.ts`: table + acceptance (invalid-promo 400; `POST /admin/returns/{id}/cancel` 2xx linked to a pooled order).
- [ ] **T4.10** Docs: `docs/phase-5-implementation-plan.md`, README, and flip the stale promo `VERIFY` line in `context/checklist.md`. Confirm **no** payment/COD code path exists.
- [ ] **T4.11** *(stretch)* expired promo via `POST /admin/campaigns` (past `ends_at`) + `campaign_id`; verify apply-time behavior before modeling.

## After all four PRs
- [ ] Regenerate the **~1k** validation corpus (`TRAFFIC_TOTAL_SESSIONS=1000`, `MIX_PROFILE=signal-rich`) so Phase 7 sees the new flows, then re-ingest. This is the agreed validation pass.
- [ ] Confirm the run summary shows non-zero realized counts for all four new types and the five end-to-end acceptance signals (conversion pivot, `insufficient_inventory`, create-product, return-cancel, invalid-promo).
