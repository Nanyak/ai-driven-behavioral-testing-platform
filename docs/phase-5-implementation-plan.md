# Phase 5 — Synthetic Traffic Generator

## Goal

Produce a realistic, intentionally messy stream of Medusa API traffic that lands in Elasticsearch as structured logs, so downstream phases have something genuine to mine. The generator must avoid the "circularity trap" (plan §8): if it emits only clean scripted flows, the behavior engine just rediscovers what we hardcoded. We mix scripted, LLM-varied, and noise traffic across a **realistic situation taxonomy** (§4), and we keep the registered-customer (register→checkout) sequence as a **holdout** that exists only in LLM-varied sessions.

## Critical constraint: no persona header

The generator attaches `session_id` and `trace_id` headers only. It does **not** send a persona or role header. Role is established naturally by which auth endpoints a session hits (the JWT `actor_type` the Medusa logging middleware already records). Persona is derived later, at Phase 7, from flow content. If the generator labeled sessions, the Phase 7 "emergent discovery" claim collapses. See `persona-classification` memory and plan §10.3.

## Recommended: body capture ON in dev (enrichment, not required — ADR 0001)

Run Medusa with `LOG_CAPTURE_BODIES=true` for the MVP. The golden **oracle is the OpenAPI spec** (Phase 8 / ADR 0001), so the pipeline works with bodies off — but bodies enrich it: they give generated tests realistic **sample payloads** (`request_payload`, reused in Phase 9) and **tighten** under-specified spec schemas against real responses. This is safe because traffic runs against synthetic data with a mock payment provider (no real PII/PCI). See Phase 2 §4 (masking + §7.1 reduction still apply when capture is on).

## 1. Design principles (realism model)

The first cut of this generator produced only three identity shapes (guest, a new-customer holdout, and an LLM "customer" forced to register+checkout). Real shoppers are not always new, not always buying, and many interact *after* a purchase (status checks, returns, refunds). The model below fixes that.

1. **Separate identity from intent from outcome.** A session is a point in a 3-axis space; we sample the space rather than enumerate fixed paths.
   - **Identity:** `guest` · `returning` (account already exists, login only) · `new` (registers this session).
   - **Intent:** browse · buy · manage-account · check-order · return.
   - **Outcome:** complete · abandon (and *where* it abandons) · error.
2. **Two-layer frequency model.** A *realistic shape* sets relative weights (§4); *minimum floors* (§7) guarantee enough of each terminal flow for PrefixSpan; *total N* is scaled so shape × N clears the floors. Default `N≈300`, profile = `realistic`.
3. **State is real, not faked.** Returns reference real completed orders; returning customers log into real pre-existing accounts; admin refunds process real return requests. This requires a **staged run** with a shared run-state store (§5).
4. **Don't break the holdout or the circularity guard.** The single-session `register → login → … → complete` sequence stays **LLM-only** (`personas/`), never scripted. Returning-customer checkout (login-only, no register) is a *different* sequence and is safe to script — it does not leak the holdout. `register` and `login` end up **decoupled in the data** (signup-only sessions emit register-without-checkout; returning sessions emit login-without-register across different `session_id`s), which is what finally lets Phase 7 separate the two behaviors instead of rediscovering a hardcoded coupling.

## 2. Location

```
services/traffic-generator/
  src/
    client.ts            # HTTP client wrapper, header injection, retry hooks
    config.ts            # env loading, mix profile, weights, event probs, floors
    state.ts             # RunState: account / order / return pools, refund linkage
    ids.ts               # session_id / trace_id generators
    taxonomy.ts          # session types, stage map, weighted allocation, identity assignment
    dispatch.ts          # runs one session per (type, identity); pools orders/returns
    reporting.ts         # observed-vs-target distribution + acceptance-gate tables
    util/
      random.ts          # pick / chance / shuffleInPlace — single source for randomness
    api/
      step.ts            # StepResult, recordStep, MISSING sentinel
      store-session.ts   # StoreSession — Store API methods
      admin-session.ts   # AdminSession — Admin API methods
    flows/
      guest.ts           # scripted guest backbone (browse/cart/checkout)
      admin.ts           # scripted admin backbone (+ promo seed, fulfill, refund)
      edge.ts            # edge-case / error flows
      returning.ts       # returning-customer browse/buy (login-only, no register)
      account.ts         # order-status + profile/address management (no purchase)
      returns.ts         # customer return request against a real order
    llm/
      narrative.ts       # Claude call -> session narrative (kinds incl. returning)
    personas/
      customer-llm.ts    # register→login→checkout, LLM-varied ONLY (holdout)
    run.ts               # staged orchestrator: seed -> buy -> post-purchase
  package.json
  .env.example
```

> Structure note: `api/` holds the Store/Admin API method classes (split out of
> the former `actions.ts`); `taxonomy.ts` is the former `sampling.ts` plus the
> identity-assignment logic; and the orchestrator delegates per-session work to
> `dispatch.ts` and end-of-run reporting to `reporting.ts`. The LLM narrative is
> replayed directly by `personas/customer-llm.ts`; the old `llm/translate.ts`
> generic replayer was unused and has been removed.

## 3. Identities

- **Guest** — never authenticates. Cart carries only an email; JWT role stays `null`. Covers guest checkout *and* guest browsing/abandonment.
- **Returning** — account already exists (created in Stage 0); the session **logs in only**, no register. The realistic majority of authenticated traffic.
- **New** — registers during the session. Two sub-cases: (a) **signup-only** (Stage 0 pool seeding — "made an account, hasn't bought"), and (b) the **holdout** register→login→checkout, LLM-only.

## 4. Situation taxonomy & target frequencies

Anchored to public e-commerce benchmarks: ~70% cart abandonment (Baymard), ~2–3% true conversion, guest checkout ≈ half of all checkouts, returns ≈ 10–15% of orders. Pure realism (2% conversion) starves mining, so purchase/return/refund weights are **elevated to a "signal-rich realistic" profile** — proportions stay realistic *relative to each other*, with floors (§7). All weights tunable in config (§6). Example counts shown for `N=300`.

| # | Session type | Identity split | Weight | ~Count | Terminal outcome |
|---|---|---|---|---|---|
| **A** | **Window-shop / bounce** (no cart) | guest 90 / returning 10 | 38% | 114 | leave after 1–4 product views |
| A1 | bounce (list or 1 detail, leave) | | 20% | 60 | |
| A2 | deeper browse + search + filter, no cart | | 18% | 54 | |
| **B** | **Cart abandonment** (cart, no order) | guest 70 / returning 25 / new 5 | 22% | 66 | abandon |
| B1 | add-to-cart then leave (no checkout start) | | 13% | 39 | |
| B2 | checkout started then drop | | 9% | 27 | drop at address/shipping/payment |
| **C** | **Completed purchase** | guest 50 / returning 38 / new 12 | 16% | 48 | order placed |
| C1 | guest checkout | | 8% | 24 | |
| C2 | returning-customer checkout | | 6% | 18 | |
| C3 | new-customer register→checkout **[HOLDOUT]** | | 2% | 6 | LLM-only |
| **D** | **Account / post-purchase, no new order** | returning 100 | 12% | 36 | |
| D1 | order status / track order | | 7% | 21 | login → view_orders → view_order → leave |
| D2 | profile & address management | | 5% | 15 | login → update profile/address → leave |
| **E** | **Returns** (references a real order) | returning 100 | 4% | 12 | `POST /store/returns` |
| **F** | **Admin operations** | admin | 6% | 18 | |
| F1 | catalog management | | 2% | 6 | |
| F2 | order fulfillment (fulfills C orders) | | 2% | 6 | |
| F3 | **return/refund processing** (pairs with E) | | 1.5% | 5 | |
| F4 | support lookup (find customer/order) | | 0.5% | 1 | |
| **G** | **Edge / error / abuse** | mixed | 2% | 6 | 4xx/5xx |
|  | **Total** | | 100% | 300 | |

**Plus Stage-0 setup (separate from the 300):** `K≈25` **signup-only** sessions (`register`, maybe set profile, leave). These populate the returning-customer pool *and* are a legitimate "registered, dormant" persona. Because they register **without** an immediate login+checkout, they do not form the holdout sequence.

**Identity split across all completed orders:** guest ≈ 50%, returning ≈ 38%, new ≈ 12% — matches "guest checkout ≈ half" and keeps registration genuinely rare, which makes the C3 holdout realistic rather than contrived.

### 4.1 Event-level conditional frequencies (within a flow)

| Event | Probability / distribution |
|---|---|
| Products viewed per session | geometric, mean ≈ 2.5, cap 8 |
| Search used (`?q=`) | 30% of browse sessions |
| Category/collection filter | 25% of browse sessions |
| 2nd line item added | 35%; 3rd item 15% |
| `update_item` quantity | 25% |
| `remove_item` | 15% |
| **Promo code attempted** (cart sessions) | 25% |
| — of attempts, code **invalid/expired** | 45% (`WELCOME10`); else valid (`SAVE10`, seeded §5) |
| **Deal-seeker** (only converts if discount applied) | 30% of promo-attempt sessions |
| Checkout-start abandon point | address 35% / shipping 25% / payment 30% / review 10% (Baymard shape) |
| Retry after a 4xx | 50% retry once; of retries 50% corrected, 50% still-wrong |
| Returning customer also reorders during status check | 20% |
| Completed order later gets a return request | ~12% of orders (realized as Stage-2 sessions) |
| Return is a single item from a multi-item order | 80% |
| Persona contamination (one out-of-role call) | 8% of sessions |

## 5. Architecture: staged pipeline with shared state

Returns, reorders, order-status, admin fulfillment, and refunds all need **prior** state, so the run is split into ordered stages over a shared `RunState`:

```ts
RunState {
  accountPool: { email, password, token? }[]      // returning customers
  orderPool:   { orderId, ownerEmail, token, items[], regionId }[]
  returnPool:  { orderId, returnId }[]             // returns awaiting admin refund
  validPromoCode: string                            // seeded in Stage 0
}
```

- **Stage 0 — Seed.**
  1. Admin login → **create a valid promotion** (e.g. `SAVE10`, percentage off) via Admin API so deal-seeker flows can actually succeed. Without this, *every* promo 400s and the "discount applied → convert" path never exists. Assert the code applies once before Stage 1.
  2. `K` **signup-only** sessions → fill `accountPool`.
- **Stage 1 — Browse & buy (the bulk: A, B, C, D2, F1).** Completed orders push `{orderId, owner, items}` into `orderPool`. Returning identities draw an account from `accountPool` and **login only** (no register).
- **Stage 2 — Post-purchase (D1, E, reorders, F2, F3, F4).** Draw from `orderPool`:
  - **E** picks an order owned by the session's account, fetches `return-reasons`, submits `POST /store/returns`, pushes `{orderId, returnId}` to `returnPool`.
  - **F2** admin fulfills random `orderPool` orders.
  - **F3** admin processes `returnPool` entries and issues the refund — **same `order_id` the customer touched in E**, producing a genuine cross-role flow for Phase 7 to discover.

Stages run sequentially; sessions *within* a stage keep bounded concurrency (e.g. 5). Stage 2 must hard-fail loudly if `orderPool` is empty (means Stage 1 produced no orders).

## 6. Implementation steps

1. **Client + config.** (Existing.) Inject `x-session-id`, `x-trace-id`, `x-publishable-api-key`. Surface 4xx/5xx without throwing. Config gains `MIX_PROFILE`, `TRAFFIC_TOTAL_SESSIONS`, `ACCOUNT_POOL_SIZE`, a `weights` block (§4), an `eventProbs` block (§4.1), and `floors` (§7).
2. **ID helpers.** (Existing.) `session_id = sess-<source>-<uuid>` (source tag for *our* debugging only — Phase 7 must not parse it). `trace_id` = uuid per request.
3. **State store (`state.ts`).** `RunState` with account / order / return pools and helpers to register, draw, and record.
4. **Taxonomy (`taxonomy.ts`).** Session-type list + stage map, weighted pick over the §4 taxonomy, identity-split sampling, and per-type identity assignment (`identityFor`); floor top-up lives in `run.ts`.
5. **API sessions (`api/`).** `api/store-session.ts` — `StoreSession`: `searchProducts`, `listCategories`/`filterProducts`, `getReturnReasons`, `requestReturn` (`POST /store/returns`), `updateProfile`, `addAddress`, `applyPromoCode`, `reorder`, `loginExisting` (login **without** the register-first fallback — the coupling that makes returning customers impossible today). `api/admin-session.ts` — `AdminSession`: `createPromotion`, `createFulfillment`, `listReturns`/`processRefund`, `getOrder`, `searchCustomer`. Both share `api/step.ts` (`StepResult`, `recordStep`, `MISSING`).
6. **Scripted flows.** `flows/guest.ts` (existing backbone), `flows/returning.ts` (login-only browse/buy), `flows/account.ts` (order-status + profile mgmt), `flows/returns.ts` (return request), `flows/edge.ts` (existing).
7. **LLM-varied traffic** (Haiku 4.5, `claude-haiku-4-5-20251001`):
   - `narrative.ts`: kinds `guest` | `returning` | `new-customer`. The `new-customer` prompt couples register+login+checkout (holdout only); `returning` must **not** register. Prompt template in plan §8.2.
   - `personas/customer-llm.ts`: realizes the **full register→login→checkout holdout**, replaying the narrative's pre-checkout browse actions and guaranteeing the checkout backbone. This sequence appears **only** here, never in `flows/`.
8. **Noise injection** (plan §8.3): abandonment (cut at a realistic step per §4.1), retry-on-4xx, contamination (one out-of-role call), shuffling. (Existing `noise.ts`.)
9. **Staged orchestrator (`run.ts`).** Build the weighted mix, run Stage 0 → 1 → 2 with bounded concurrency, apply floor top-up. Per-session work is delegated to `dispatch.ts` (which pools resulting orders/returns and records refund linkage on `RunState`); the observed-vs-target summary table plus the holdout and cross-role linkage counts are rendered by `reporting.ts`.

## Model / cost

- Bulk narratives: **Haiku 4.5** — low cost/latency, ~20–40 calls per run.
- No Opus here; Opus is reserved for Phase 7 naming/anomaly calls.
- Add `ANTHROPIC_API_KEY`, `TRAFFIC_LLM_MODEL=claude-haiku-4-5-20251001` to `.env.example`.

## Data contract produced (in logs → ES)

Each request yields one `behavior-logs-*` document (production-shaped hybrid) with: `timestamp`, `level`, `service`, `environment`, `request_id`, `trace_id`, `session_id`, `user_role` (`customer` / `admin` / `null` for guests, derived from the JWT by the middleware — **not** from us), `user_id`, `event`, `method`, `endpoint` (normalized), `status`, `duration_ms`, `source: "medusa"`. The expanded action surface now also yields return (`POST /store/returns`), refund/fulfillment (admin), profile, search, and promo events. Bodies (`request_payload` / `response_body`, reduced per plan §7.1) appear only when `LOG_CAPTURE_BODIES=true`.

## 7. Validation / acceptance

- `npm run generate` runs all stages end to end without crashing; Stage 2 errors loudly on empty pools.
- Generated traffic appears in Medusa logs and then in `behavior-logs-*` (`npm run check:phase5`).
- **Distribution check:** realized session-type histogram within ±25% of §4 targets (observed-vs-target printed in the summary).
- **Funnel check:** cart→order conversion and ~70% abandonment reproduced from logs.
- **Floors met** (config `floors`): `MIN_HOLDOUT=6`, `MIN_RETURNING_CHECKOUT=5`, `MIN_GUEST_CHECKOUT=5`, `MIN_RETURNS=5`, `MIN_LINKED_REFUNDS=5`, `MIN_PROMO_SUCCESS=3`. After building the weighted mix, top up any flow below its floor.
- **Holdout check:** ≥6 completed registered-customer checkouts (role transitions null→customer ending in `POST /store/carts/{id}/complete`), with **no** corresponding scripted flow in `flows/`.
- **Cross-role linkage:** ≥5 `order_id`s carrying **both** a customer `POST /store/returns` event and an admin refund event (join logs on `order_id`).
- **Identity decoupling:** logs contain `register`-without-checkout sessions AND `login`-without-register sessions.
- Edge + invalid promos + retries yield a healthy 4xx/5xx share for error-flow mining.

## Risks

- **Holdout starvation:** if LLM sessions rarely complete checkout, the flow won't clear PrefixSpan support. Mitigate by forcing ≥6 completed customer checkouts in `customer-llm.ts` (floor top-up).
- **Return endpoint prerequisites:** `POST /store/returns` (`createAndCompleteReturnOrderWorkflow`, Medusa ≥2.8) needs valid order item ids and a return shipping `option_id`; resolve both at runtime from the order + region.
- **Admin refund/fulfillment paths** differ across Medusa 2.x minors — verify against the running 2.15.5 instance before wiring (don't hardcode from memory).
- **Promo seeding:** if Stage-0 promotion creation fails, deal-seeker conversions vanish — assert the valid code applies once before Stage 1.
- **Stage ordering bug = empty pools:** Stage 2 must hard-fail loudly rather than silently emitting 0 returns.
- **Source-tag leakage:** keep the `<source>` tag in `session_id` out of any field Phase 7 reads as a signal; human debugging only.
- **Seed-data coupling:** resolve product/variant/region IDs at runtime, never hardcode.
- **Floors vs realism:** elevated E/refund weights are above real life by design; the `realistic` vs `signal-rich` presets keep the proportion honest.
