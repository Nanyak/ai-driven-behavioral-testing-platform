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
3. **State is real, not faked.** Return inquiries reference real completed orders; returning customers log into real pre-existing accounts; admin returns/refunds and cancels operate on real fulfilled/unfulfilled orders. This requires a **staged run** with a shared run-state store (§5).
4. **Don't break the holdout or the circularity guard.** The single-session `register → login → … → complete` sequence stays **LLM-only** (`personas/`), never scripted. Returning-customer checkout (login-only, no register) is a *different* sequence and is safe to script — it does not leak the holdout. `register` and `login` end up **decoupled in the data** (signup-only sessions emit register-without-checkout; returning sessions emit login-without-register across different `session_id`s), which is what finally lets Phase 7 separate the two behaviors instead of rediscovering a hardcoded coupling.

## 2. Location

```
services/traffic-generator/
  src/
    client.ts              # HTTP wrapper, header injection (no persona header), retry hooks
    config.ts              # env loading, mix profile, weights, event probs, floors
    state.ts               # RunState: account / order / return pools, fulfillment + refund/cancel linkage
    ids.ts                 # session_id / trace_id / customer-email generators
    taxonomy.ts            # session types, stage map, weighted allocation, identity assignment
    noise.ts               # abandonment + retry-on-4xx helpers (LIGHT_NOISE, runSteps, maybeAbandon)
    dispatch.ts            # runs one session per (type, identity); pools orders/returns
    reporting.ts           # observed-vs-target distribution + acceptance-gate tables
    util/
      random.ts            # pick / chance / shuffleInPlace — single source for randomness
    api/
      step.ts              # StepResult, recordStep, MISSING sentinel
      store-session.ts     # StoreSession — Store API methods, runtime ID resolution
      admin-session.ts     # AdminSession — Admin API methods
    flows/
      guest.ts             # guest backbone — browse-only (bounce/browse); carts require auth
      returning.ts         # returning customer (login-only or JWT-reuse, no register)
      direct-landing.ts    # share-link / ad product landing (view_product first)
      comparison-browse.ts # researcher: 4–8 product views, search-first, no purchase
      multi-item.ts        # bulk-add: 3–5 browse→add cycles then checkout
      account.ts           # order-status (D1) + repeat-check (D1b) + profile/address (D2)
      returns.ts           # customer return INQUIRY (read-only) against a real order
      admin.ts             # admin catalog (F1) + fulfill (F2) + refund (F3) + support (F4)
      edge.ts              # edge-case / error flows (G)
    llm/
      narrative.ts         # Haiku 4.5 narrative (kinds incl. returning) + offline fallback
    personas/
      customer-llm.ts      # register→login→checkout, LLM-varied ONLY (holdout)
    run.ts                 # staged orchestrator: seed -> buy -> post-purchase
  package.json
  .env.example
```

> Structure note: `api/` holds the Store/Admin API method classes (split out of
> the former `actions.ts`); `taxonomy.ts` is the former `sampling.ts` plus the
> identity-assignment logic; and the orchestrator delegates per-session work to
> `dispatch.ts` and end-of-run reporting to `reporting.ts`. The LLM narrative is
> replayed directly by `personas/customer-llm.ts`; the old `llm/translate.ts`
> generic replayer was unused and has been removed. The flow set was expanded with
> four Shopee/Lazada-shaped leaves — `direct-landing.ts` (share-link product
> landing), `comparison-browse.ts` (high product-view research), `multi-item.ts`
> (bulk-add checkout), and the `repeatOrderCheck` path in `account.ts`
> (tracking-anxiety status loops).

## 3. Identities

- **Guest** — never authenticates; **browse-only**. The storefront requires auth before add-to-cart, so guests never create a cart (JWT role stays `null`). Covers bounce, browse, comparison-browse, and the bounce/browse direct-landing intents. (Guest *checkout* was removed — it is not reachable through the storefront — so completed orders are returning/new only.)
- **Returning** — account already exists (created in Stage 0). The session either **logs in only** (no register), OR — ~55% of the time — **reuses a still-live JWT** and emits a synthetic `resume_session` step instead of a `login` event. The realistic majority of authenticated traffic, and the source of every cart-bearing session.
- **New** — registers during the session. Two sub-cases: (a) **signup-only** (Stage 0 pool seeding — "made an account, hasn't bought"), and (b) the **holdout** register→login→checkout, LLM-only.

## 4. Situation taxonomy & target frequencies

Anchored to public e-commerce benchmarks: ~70% cart abandonment (Baymard), ~2–3% true conversion, returns ≈ 10–15% of orders. (The usual "guest checkout ≈ half" benchmark does **not** apply here: this storefront requires authentication before add-to-cart, so guest checkout is unreachable and every cart-bearing session is a returning customer.) Pure realism (2% conversion) starves mining, so purchase/return/refund weights are **elevated to a "signal-rich realistic" profile** — proportions stay realistic *relative to each other*, with floors (§7). All weights tunable in config (§6). Example counts shown for `N=300`.

The taxonomy is realized as **19 session-type leaves** (the `SESSION_TYPES` array
in `taxonomy.ts`); weights live in `config.ts` (`REALISTIC_WEIGHTS` /
`SIGNAL_RICH_WEIGHTS`). Weights are relative and normalized to the configured
total via largest-remainder allocation. Counts below are the `realistic` profile
at `N=300` (weights sum to ≈99, so count ≈ weight × 3).

| Group | Leaf (`SessionType`) | Identity split | Weight | ~N=300 | Distinguishing log signal |
|---|---|---|---|---|---|
| **A** | **Window-shop / browse** (no cart) | guest-dominant | **33%** | ~99 | |
| | `bounce` | guest 90 / returning 10 | 15% | ~45 | view 1–2 products, exit |
| | `browse` | guest 90 / returning 10 | 12% | ~36 | search/filter + 1–2 views, no cart |
| | `comparisonBrowse` | guest 80 / returning 20 | 6% | ~18 | **4–8 `view_product`**, search-first 60% |
| **B** | **Cart / checkout abandonment** (auth-required) | returning 100 | **19%** | ~57 | abandon |
| | `cartAbandon` | returning 100 | 11% | ~33 | login → cart, items added, no checkout |
| | `checkoutAbandon` | returning 100 | 8% | ~24 | checkout started, Baymard-weighted cut |
| **C** | **Completed purchase / landing** | mixed | **25%** | ~75 | order placed (except landing bounces) |
| | `returningCheckout` | returning 100 | 12% | ~36 | login/`resume_session` → cart → complete |
| | `directLanding` | guest 70 / returning 30† | 7% | ~21 | **first step is `view_product`** |
| | `multiItemCheckout` | returning 100 | 4% | ~12 | **3–5 browse→add cycles**, 3+ line items |
| | `cartWallConversion` | returning (guest→login) | — | — | guest `create_cart` **401** → `login` → `create_cart` **200** → buy/abandon (`wallBounce` stops at the 401); the 401→login→200 pivot |
| | `newCheckout` **[HOLDOUT]** | new | 2% | ~6 | LLM-only `register → login → checkout` |
| **D** | **Account / post-purchase, no new order** | returning 100 | **11%** | ~33 | |
| | `orderStatus` | returning 100 | 5% | ~15 | login → view orders → view order → maybe reorder |
| | `repeatOrderCheck` | returning 100 | 3% | ~9 | **view same order 3–5×** (tracking anxiety) |
| | `profileMgmt` | returning 100 | 3% | ~9 | login → update profile/address |
| **E** | **Return inquiry** (references a real order) | returning 100 | **3%** | ~9 | login → view orders → **view a fulfilled order** (read-only; storefront has no customer return endpoint, so this only flags the order for admin settlement) |
| **F** | **Admin operations** | admin | **8%** | ~24 | |
| | `adminCatalog` | admin | 2% | ~6 | list/view/update products |
| | `adminFulfill` | admin | 3% | ~9 | fulfill order-pool orders (Stage 2a — makes them returnable) |
| | `adminRefund` | admin | 1.5% | ~5 | **return + refund** a fulfilled order — same `order_id` a customer inquired about (linkage) |
| | `adminCancel` | admin | 2% | ~6 | **cancel + refund** an UNFULFILLED order (reversal before shipping) |
| | `adminSupport` | admin | 0.5% | ~1 | search customers by email |
| **G** | **Edge / error / abuse** | mixed | **2%** | ~6 | intentional 4xx/5xx |
| | **Total** | | **100%** | **300** | |

† `directLanding` guest identity applies only to its bounce/browse intents; its
cart-bearing intents force a returning account (storefront auth requirement).

**Plus Stage-0 setup (separate from the 300):** `ACCOUNT_POOL_SIZE≈25` **signup-only** sessions (`register`, maybe set profile, leave). These populate the returning-customer pool *and* are a legitimate "registered, dormant" persona. Because they register **without** an immediate login+checkout, they do not form the holdout sequence.

**Identity split across all completed orders:** returning ≈ 88%, new ≈ 12% (the C `newCheckout` holdout). Guest checkout was removed because the storefront requires authentication before add-to-cart, so every cart-bearing session draws a pooled returning account; guest identity is browse-only. Registration stays genuinely rare, which keeps the `newCheckout` holdout realistic rather than contrived. Returning authentication splits three ways in the logs — `login` (fresh token, ~45%), `resume_session` (live JWT reuse, ~55%), and the Stage-0 `register`-without-checkout sessions — which is what lets Phase 7 decouple sign-in from sign-up.

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
| Returning session reuses a live JWT (`resume_session`, no `login` event) | ~55% |
| Returning customer also reorders during status check | 20% |
| Fulfilled order later gets a customer return inquiry → admin return+refund | ~12% of orders (realized as Stage-2b sessions) |
| Unfulfilled order canceled by admin (pre-shipping reversal) | realized as Stage-2b `adminCancel` sessions |
| Return is a single item from a multi-item order | 80% |
| Persona contamination (one out-of-role call) | 8% of sessions |

## 5. Architecture: staged pipeline with shared state

Returns, reorders, order-status, admin fulfillment, and refunds all need **prior** state, so the run is split into ordered stages over a shared `RunState`:

```ts
RunState {
  accountPool: { email, password, token? }[]      // returning customers
  orderPool:   { orderId, ownerEmail, token, items[], regionId,
                 returnRequested?, fulfilled?, returned?, canceled? }[]
  returnPool:  { orderId, returnId }[]             // admin-filed returns
  refundedOrderIds: Set<string>                     // admin-refunded (return path)
  canceledOrderIds: Set<string>                     // admin-canceled (cancel path)
  validPromoCode: string                            // seeded in Stage 0
}
```

- **Stage 0 — Seed.**
  1. Admin login → **create a valid promotion** (e.g. `SAVE10`, percentage off) via Admin API so deal-seeker flows can actually succeed. Without this, *every* promo 400s and the "discount applied → convert" path never exists. Assert the code applies once before Stage 1.
  2. `K` **signup-only** sessions → fill `accountPool`.
- **Stage 1 — Browse & buy (the bulk: A, B, C, D2, F1, G).** Completed orders push `{orderId, owner, items}` into `orderPool`. Returning identities draw an account from `accountPool` and either **login only** (no register) or, ~55% of the time, **reuse the still-live JWT** and emit a synthetic `resume_session` step (no auth endpoint hit). Cart-bearing sessions always authenticate this way — the storefront blocks anonymous carts.
- **Stage 2 — Post-purchase.** Runs in **two ordered waves** because returns/refunds and cancels are **admin-operated** — the storefront exposes no customer reversal endpoint, and this Medusa build verifiably (a) rejects a return for more than was *fulfilled* and (b) rejects canceling a *fulfilled* order. So fulfillment must precede the return path, and cancels only apply to unfulfilled orders:
  - **Stage 2a — Fulfillment (F2).** Admin fulfills pooled orders; each success marks the order `fulfilled` (claimed synchronously so concurrent sessions don't double-fulfill). This is the prerequisite that makes an order returnable.
  - **Stage 2b — Post-purchase & reversals (D1, E, F3, F5, F4).** Draw from `orderPool`:
    - **E (return inquiry)** picks a **fulfilled** order owned by the session's account, logs in, and views it (read-only). It flags the order `returnRequested` — the cross-role touch — but issues no return call (the storefront has none).
    - **F3 (return + refund)** runs the full admin return lifecycle on a **fulfilled** order, preferring one a customer inquired about: `POST /admin/returns` (+`location_id`) → `request-items` → `request` (return filed) → `receive` → `receive-items` → `receive/confirm` (refund settled). Same `order_id` the customer placed/inquired about — the cross-role linkage Phase 7 discovers.
    - **F5 (cancel + refund)** cancels an **unfulfilled** order via `POST /admin/orders/{id}/cancel`, reversing the authorized payment — the "changed their mind before it shipped" reversal.

Stages run sequentially; sessions *within* a wave keep bounded concurrency (e.g. 5). Stage 2 must hard-fail loudly if `orderPool` is empty (means Stage 1 produced no orders).

## 6. Implementation steps

1. **Client + config.** (Existing.) Inject `x-session-id`, `x-trace-id`, `x-publishable-api-key`. Surface 4xx/5xx without throwing. Config gains `MIX_PROFILE`, `TRAFFIC_TOTAL_SESSIONS`, `ACCOUNT_POOL_SIZE`, a `weights` block (§4), an `eventProbs` block (§4.1), and `floors` (§7).
2. **ID helpers.** (Existing.) `session_id = sess-<source>-<uuid>` (source tag for *our* debugging only — Phase 7 must not parse it). `trace_id` = uuid per request.
3. **State store (`state.ts`).** `RunState` with account / order / return pools and helpers to register, draw, and record.
4. **Taxonomy (`taxonomy.ts`).** Session-type list + stage map, weighted pick over the §4 taxonomy, identity-split sampling, and per-type identity assignment (`identityFor`); floor top-up lives in `run.ts`.
5. **API sessions (`api/`).** `api/store-session.ts` — `StoreSession`: `searchProducts`, `listCategories`/`filterProducts`, `updateProfile`, `addAddress`, `applyPromoCode`, `reorder`, `viewOrders`/`viewOrder` (the read-only return-inquiry surface), `loginExisting` (login **without** the register-first fallback — the coupling that makes returning customers impossible today). No customer return/refund methods — the storefront has none. `api/admin-session.ts` — `AdminSession`: `createPromotion`, `createFulfillment`, `resolveStockLocation`, the return lifecycle (`beginReturn`/`requestReturnItems`/`confirmReturnRequest`/`receiveReturn`/`receiveReturnItems`/`confirmReturnReceipt`), `cancelOrder`, `listReturns`, `getOrder`, `searchCustomer`. Both share `api/step.ts` (`StepResult`, `recordStep`, `MISSING`).
6. **Scripted flows.** `flows/guest.ts` (browse/cart backbone), `flows/returning.ts` (login-only **or** JWT-reuse browse/buy), `flows/direct-landing.ts` (share-link `view_product`-first landing), `flows/comparison-browse.ts` (4–8 product-view researcher), `flows/multi-item.ts` (3–5 browse→add bulk checkout), `flows/account.ts` (order-status D1, repeat-check D1b, profile mgmt D2), `flows/returns.ts` (read-only customer return **inquiry** E), `flows/admin.ts` (catalog/fulfill/return+refund/cancel/support F1–F5), `flows/edge.ts` (error G).
7. **LLM-varied traffic** (Haiku 4.5, `claude-haiku-4-5-20251001`):
   - `narrative.ts`: kinds `guest` | `returning` | `new-customer`. The `new-customer` prompt couples register+login+checkout (holdout only); `returning` must **not** register. Prompt template in plan §8.2.
   - `personas/customer-llm.ts`: realizes the **full register→login→checkout holdout**, replaying the narrative's pre-checkout browse actions and guaranteeing the checkout backbone. This sequence appears **only** here, never in `flows/`.
8. **Noise injection** (plan §8.3): abandonment (cut at a realistic step per §4.1), retry-on-4xx, contamination (one out-of-role call), shuffling. (Existing `noise.ts`.)
9. **Staged orchestrator (`run.ts`).** Build the weighted mix, run Stage 0 → 1 → 2a → 2b with bounded concurrency, apply floor top-up. Per-session work is delegated to `dispatch.ts` (which pools resulting orders, fulfillment/return/cancel state, and records refund linkage on `RunState`); the observed-vs-target summary table plus the holdout, cross-role linkage, and cancel counts are rendered by `reporting.ts`.

## Model / cost

- Bulk narratives: **Haiku 4.5** — low cost/latency, ~20–40 calls per run.
- No Opus here; Opus is reserved for Phase 7 naming/anomaly calls.
- Add `ANTHROPIC_API_KEY`, `TRAFFIC_LLM_MODEL=claude-haiku-4-5-20251001` to `.env.example`.

## Data contract produced (in logs → ES)

Each request yields one `behavior-logs-*` document (production-shaped hybrid) with: `timestamp`, `level`, `service`, `environment`, `request_id`, `trace_id`, `session_id`, `user_role` (`customer` / `admin` / `null` for guests, derived from the JWT by the middleware — **not** from us), `user_id`, `event`, `method`, `endpoint` (normalized), `status`, `duration_ms`, `source: "medusa"`. The expanded action surface now also yields admin return/refund (`POST /admin/returns` + the receive/confirm sequence), admin cancel (`POST /admin/orders/{id}/cancel`), fulfillment, profile, search, and promo events. (Returns/refunds/cancels are **admin-only** — the storefront exposes no customer reversal endpoint.) Bodies (`request_payload` / `response_body`, reduced per plan §7.1) appear only when `LOG_CAPTURE_BODIES=true`.

## 7. Validation / acceptance

- `npm run generate` runs all stages end to end without crashing; Stage 2 errors loudly on empty pools.
- Generated traffic appears in Medusa logs and then in `behavior-logs-*` (`npm run check:phase5`).
- **Distribution check:** realized session-type histogram within ±25% of §4 targets (observed-vs-target printed in the summary).
- **Funnel check:** cart→order conversion and ~70% abandonment reproduced from logs.
- **Floors met** (config `floors`): `holdout=6`, `returningCheckout=10`, `returns=5`, `linkedRefunds=5`, `canceledOrders=5`, `promoSuccess=3` (the `smoke` profile shrinks these to 2/4/1/1/1/1). There is no longer a guest-checkout floor — guest checkout was removed. After building the weighted mix, top up any flow below its floor. Fulfillment (F2) is auto-topped above the return floor (`adminRefund + 3`) so Stage 2b always has fulfilled orders to return.
- **Holdout check:** ≥6 completed registered-customer checkouts (role transitions null→customer ending in `POST /store/carts/{id}/complete`), with **no** corresponding scripted flow in `flows/`.
- **Cross-role linkage:** ≥5 `order_id`s carrying **both** a customer event (placement/inquiry) and the admin return+refund sequence — i.e. an order in both `returnPool` and `refundedOrderIds` (join logs on `order_id`). Returns are admin-filed; the customer touch is the placement (Stage 1) and the read-only return inquiry (E).
- **Admin cancels:** ≥5 unfulfilled orders canceled via `POST /admin/orders/{id}/cancel` (the pre-shipping reversal path).
- **Identity decoupling:** logs contain `register`-without-checkout sessions, `login`-without-register sessions, AND `resume_session` (live-JWT) sessions — three distinct authentication patterns for Phase 7 to separate.
- Edge + invalid promos + retries yield a healthy 4xx/5xx share for error-flow mining.

## Risks

- **Holdout starvation:** if LLM sessions rarely complete checkout, the flow won't clear PrefixSpan support. Mitigate by forcing ≥6 completed customer checkouts in `customer-llm.ts` (floor top-up).
- **Returns are admin-only and fulfillment-gated.** The customer `POST /store/returns` path is dead on this build (the seed has no return shipping `option_id`), and the storefront exposes no customer return UI. Returns run entirely admin-side via `POST /admin/returns` → request → receive/confirm, and **only cover fulfilled quantities** — verified error: *"Cannot request to return more items than what was fulfilled."* Hence Stage 2a fulfills first. The return must be bound to a `location_id` at begin time or `receive/confirm` 500s ("Cannot receive the Return at location null").
- **Cancel is unfulfilled-only.** `POST /admin/orders/{id}/cancel` succeeds on unfulfilled orders but 400s on fulfilled ones (*"All fulfillments must be canceled before canceling an order"*). The dead `POST /admin/orders/{id}/refunds` route (404 on this build) is **not** used.
- **Admin refund/fulfillment/cancel paths** differ across Medusa 2.x minors — verify against the running 2.15.5 instance before wiring (don't hardcode from memory).
- **Promo seeding:** if Stage-0 promotion creation fails, deal-seeker conversions vanish — assert the valid code applies once before Stage 1.
- **Stage ordering bug = empty pools:** Stage 2 must hard-fail loudly rather than silently emitting 0 returns.
- **Source-tag leakage:** keep the `<source>` tag in `session_id` out of any field Phase 7 reads as a signal; human debugging only.
- **Seed-data coupling:** resolve product/variant/region IDs at runtime, never hardcode.
- **Floors vs realism:** elevated E/refund weights are above real life by design; the `realistic` vs `signal-rich` presets keep the proportion honest.
