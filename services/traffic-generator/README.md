# Traffic Generator (Phase 5)

Produces a realistic, intentionally messy stream of Medusa API traffic so the
downstream behavior engine has genuine data to mine. Traffic is sampled from a
**19-leaf situation taxonomy** (plan §4) across three axes — **identity**
(guest / returning / new), **intent** (browse / buy / manage / status / return),
and **outcome** (complete / abandon / error) — and keeps the registered-customer
`register → login → checkout` sequence as a **holdout** that exists only in
LLM-varied sessions (`personas/customer-llm.ts`), never in `flows/`.

The situation mix is modelled on real Shopee / Lazada traffic patterns: search-first
entry, share-link product landings, multi-item bulk carts, comparison-shopping
sessions, JWT-reuse without re-login, and post-purchase tracking-anxiety loops.

## What it does NOT do

- It never sends a persona or role header. Role is established naturally by
  which auth endpoints a session hits (the Medusa logging middleware records the
  JWT `actor_type`). Persona is derived later, in Phase 7, from flow content.
  The `<source>` tag in `session_id` (`sess-<source>-<uuid>`) is for human
  debugging only and must not be read as a classifier signal.
- It never scripts the holdout. Returning-customer checkout (login-only) IS
  scripted — it is a *different* sequence and emits `login` without `register`,
  which (mirrored against the Stage-0 signup-only sessions that emit `register`
  without checkout) is what lets Phase 7 decouple sign-in from sign-up.
- It never hardcodes product or order IDs. Every runtime ID (region, product,
  variant, cart, order, return) is resolved against the live backend so the run
  is reproducible against any seeded Medusa instance.
- It never creates an anonymous (guest) cart. The storefront requires
  authentication before adding to cart, so every cart-bearing session uses a
  pooled returning account. Unauthenticated sessions are browse-only (bounce,
  browse, comparisonBrowse, directLanding bounce/browse intents).

## Layout

The source is layered by concern: `http/` (transport), `config/` (env + taxonomy),
`api/` (Store/Admin session classes), `flows/` (per-situation scripts), and
`orchestration/` (the staged run).

```
src/
  http/
    client.ts                  HTTP wrapper, header injection (no persona header)
    noise.ts                   abandonment + retry-on-4xx helpers (LIGHT_NOISE, runSteps, maybeAbandon)
    step.ts                    StepResult, recordStep, MISSING sentinel (shared by both sessions)
  config/
    config.ts                  env loading; mix profile, weights, event probs, floors
    taxonomy.ts                session types, stage map, weighted allocation, identity assignment
    ids.ts                     session_id / trace_id / customer-email helpers
  api/
    store-session.ts           StoreSession — Store API, runtime ID resolution
    admin-session.ts           AdminSession — Admin API (role established via /auth/user)
    catalog-query.ts           shared /store/products query/param + response-mapping helpers
  orchestration/
    run.ts                     staged orchestrator: seed -> browse&buy -> fulfill -> post-purchase
    dispatch.ts                runs one session per (type, identity) and pools resulting orders/returns
    state.ts                   RunState: account / order / return pools, fulfillment + refund/cancel linkage
    reporting.ts               observed-vs-target distribution + acceptance-gate tables
  util/
    random.ts                  pick / chance / shuffleInPlace — single source for randomness
  flows/guest.ts             guest shopper (bounce/browse), browse-only
  flows/returning.ts         returning customer (login/JWT-reuse, no register) + reviseAbandon (update+remove line-item, then abandon)
  flows/direct-landing.ts    share-link / ad product landing (view_product first)
  flows/comparison-browse.ts researcher: 4–8 product views, search-first, no purchase
  flows/category-browse.ts   category-led discovery: categories + sort + pagination, no purchase
  flows/conversion.ts        cart-wall conversion: guest 401 → login → 200 (buy/abandon/bounce)
  flows/stockout.ts          stock-out checkout: over-add a low-stock variant → 400, recover/abandon
  flows/multi-item.ts        Lazada bulk-add: 3–5 browse→add cycles then checkout
  flows/account.ts           order-status (D1) + repeat-check (D1b) + profile (D2)
  flows/returns.ts           customer return INQUIRY (read-only) against a real order (E)
  flows/admin.ts             admin catalog (F1) + fulfill (F2) + return+refund (F3) + return-reject (F6) + cancel (F5) + support (F4)
  flows/promo.ts             promo-code attempt helper: valid (200 discount) vs invalid (400) per §4.1 probs
  flows/edge.ts              edge-case 4xx/5xx flows (G)
  llm/narrative.ts           Haiku 4.5 narrative (+ offline stochastic fallback)
  personas/customer-llm.ts   HOLDOUT: registered-customer full checkout (C3)
```

The Store/Admin API session classes live in `api/` (split out of the former
monolithic `actions.ts`; the shared `/store/products` query helpers are in
`api/catalog-query.ts`). The orchestrator `orchestration/run.ts` delegates
per-session work to `orchestration/dispatch.ts` and the end-of-run tables to
`orchestration/reporting.ts`.

## Staged pipeline (plan §5)

Returns, reorders, order-status, fulfillment, and refunds all need **prior**
state, so the run is split into ordered stages over a shared `RunState`:

- **Stage 0 — seed.** Admin logs in, creates a valid promotion (so deal-seeker
  conversions can succeed) and a dedicated **limited-stock product** (stock 4,
  pinned via `setInventoryLevel`) so the `stockOutCheckout` arc hits a
  deterministic `insufficient_inventory` 400 without contaminating the 12 seeded
  products; then `ACCOUNT_POOL_SIZE` **signup-only** sessions populate the
  returning-customer account pool. If create-product 4xxs, `lowStockVariantId`
  stays unset and `stockOutCheckout` degrades to a normal returning browse.
- **Stage 1 — browse & buy.** The bulk (A/B/C/D2/F1/G). Completed checkouts push
  real orders into the order pool. Returning identities draw a pooled account;
  ~55% of those sessions skip re-authentication because the customer's JWT is
  still live (`resume_session` step, no `login` event).
- **Stage 2 — post-purchase, in two waves.** Returns/refunds and cancels are
  **admin-operated** (the storefront has no customer reversal endpoint), and the
  backend gates them on order state, so fulfillment must come first:
  - **Stage 2a — fulfillment (F2).** Admin fulfills pooled orders so they become
    returnable. Each success marks the order `fulfilled` (claimed synchronously
    so concurrent sessions don't double-fulfill).
  - **Stage 2b — post-purchase & reversals.** Order-status (D1), repeat checks
    (D1b), the read-only customer return **inquiry** (E), admin **return+refund**
    (F3) on a fulfilled order, admin **return-reject** (F6) — declining a
    requested return via `POST /admin/returns/{id}/cancel` instead of refunding
    it — and admin **cancel** (F5) on an unfulfilled order. F3 settles (and F6
    rejects) the **same `order_id`** the customer placed/inquired about — the
    cross-role linkage Phase 7 discovers.

  Stage 2 hard-fails loudly if the order pool is empty.

> **Returns/refunds/cancels are admin-only and order-state-gated** (verified on
> the live 2.15.5 build): a return covers **only fulfilled quantities** and must
> be bound to a `location_id` at begin; a cancel works **only on unfulfilled**
> orders. The customer `POST /store/returns` path is dead (no return shipping
> option in the seed) and `POST /admin/orders/{id}/refunds` does not exist (404)
> — refunds are settled through the admin return receive/confirm sequence. These
> calls degrade to a logged non-2xx rather than crashing and are marked
> `// VERIFY against live backend`. If the acceptance report shows
> `✗ cross-role linked refunds` or `✗ orders canceled`, check them against the
> running instance.

## Run

```bash
# from repo root
npm run traffic:install      # one-time: install deps
npm run compose:up           # Medusa emits production-shaped logs (bodies-off)
npm run traffic:generate     # staged run (default profile: realistic, N≈300)
npm run check:phase5         # verify logs reached Elasticsearch
```

The Medusa logging middleware emits **production-shaped hybrid logs**: a logical
`service` (e.g. `cart-service`), a semantic `event` (e.g. `cart_item_added`),
`request_id`, `user_role`, `method`, `endpoint`, `status`, `duration_ms` — and
**no request/response bodies** (production = bodies-off; the OpenAPI spec is the
golden oracle per ADR 0001).

The run prints an **observed-vs-target distribution** table and an
**acceptance-gate** report (holdout, returning checkouts, returns filed,
cross-role linked refunds, admin order cancels, promo applications,
invalid-promo 400s, and admin return-rejections) plus identity-decoupling counts.

Configuration comes from the repository root `.env` (Medusa URL, publishable
key, admin creds, `ANTHROPIC_API_KEY`) with optional overrides in
`services/traffic-generator/.env` — see `.env.example`. Without
`ANTHROPIC_API_KEY` the holdout's narrative variation falls back to a local
stochastic generator, so the run still completes offline.

## Situation mix (plan §4)

`MIX_PROFILE` selects the relative weights; counts are normalized to the total,
then topped up to the floors (plan §7). Example counts shown for `N=300`.

| Profile       | Total | Shape                                                    |
| ------------- | ----- | -------------------------------------------------------- |
| `realistic`   | 300   | Shopee/Lazada-anchored (≈70% abandonment, guest ≈ half) |
| `signal-rich` | 300   | same shape, purchase/return/refund leaves boosted        |
| `smoke`       | 40    | tiny structural check                                    |

| Group | Leaves                                                              | ~Weight |
| ----- | ------------------------------------------------------------------- | ------- |
| A     | bounce, deeper browse, comparison-browse (no cart)                  | 30%     |
| B     | cart abandon, checkout abandon (both auth-required)                 | 20%     |
| C     | direct landing, returning / multi-item / new checkout (all auth)    | 24%     |
| D     | order status, repeat order check, profile management                | 10%     |
| E     | return inquiry (read-only)                                          | 3%      |
| F     | admin catalog / fulfill / return+refund / cancel / support          | 8%      |
| G     | edge / error                                                        | 2%      |

### Session types

| Type               | Stage | Identity          | Distinguishing log signal                                      |
| ------------------ | ----- | ----------------- | -------------------------------------------------------------- |
| `bounce`           | 1     | 90% guest         | view 1–2 products, exit                                        |
| `browse`           | 1     | 90% guest         | search/filter + 1–2 product views, no cart                    |
| `comparisonBrowse` | 1     | 80% guest         | **4–8 `view_product` calls**, search-first 60%                |
| `categoryBrowse`   | 1     | 80% guest         | category-led: `product-categories` → `?category_id[]=` → `?order=` (sort) → `?offset=` ("load more") → 2–4 product views |
| `cartAbandon`      | 1     | returning         | login → cart created, items added, no checkout                 |
| `checkoutAbandon`  | 1     | returning         | login → checkout started, Baymard-weighted cut (60% at payment)|
| `directLanding`    | 1     | 70% guest†        | **first step is `view_product`**, no leading `browse_products` |
| `returningCheckout`| 1     | returning         | `login` (or `resume_session`) → cart → complete               |
| `multiItemCheckout`| 1     | returning         | login → **3–5 browse→add cycles**, cart has 3+ line items     |
| `cartWallConversion`| 1    | returning (guest→login) | guest `create_cart` **401** → `login` → `create_cart` **200** → buy/abandon (`wallBounce` ends at the 401) |
| `stockOutCheckout` | 1     | returning         | login → view low-stock product → add `stock+1` → **400 insufficient inventory** → recover (add 1) / abandon |
| `cartReviseAbandon` | 1    | returning         | login → cart → add 2–3 → `update_item` (qty) → **`remove_item` (DELETE line-item)** → abandon |
| `newCheckout`      | 1     | new               | HOLDOUT — LLM-varied `register → login → checkout`            |
| `profileMgmt`      | 1     | returning         | login → view profile (`GET /store/customers/me`) → maybe browse (the storefront profile page is read-only; no profile-update/address API) |
| `adminCatalog`     | 1     | admin             | list/view/update products + `chance(0.4)` **create product**   |
| `edge`             | 1     | —                 | intentional 4xx/5xx edge cases                                |
| `orderStatus`      | 2     | returning         | login → view orders → view specific order → maybe reorder     |
| `repeatOrderCheck` | 2     | returning         | login → **view same order 3–5×** (tracking anxiety)           |
| `returns`          | 2b    | returning         | login → view orders → view a **fulfilled** order (read-only return inquiry) |
| `adminFulfill`     | 2a    | admin             | fulfill a real order from the pool (makes it returnable)       |
| `adminRefund`      | 2b    | admin             | **return + refund** a fulfilled order — same `order_id` a customer inquired about (linkage) |
| `adminReturnReject`| 2b    | admin             | **reject** a requested return on a fulfilled order: `begin → request-items → request` → `POST /admin/returns/{id}/cancel` (decline, no refund) |
| `adminCancel`      | 2b    | admin             | **cancel + refund** an UNFULFILLED order (pre-shipping reversal)|
| `adminSupport`     | 2b    | admin             | search customers by email                                      |

† `directLanding` guest identity applies only to bounce/browse intents. Cart-bearing
  direct-landing intents (`cartAbandon`, `buy`) always use a returning account.

### Identity and JWT-reuse

The storefront requires authentication before adding to cart, so all cart-bearing
sessions use a pooled returning account. Browse-only sessions (bounce, browse,
comparisonBrowse, directLanding bounce/browse intents) are unauthenticated.

Returning-identity sessions draw a pooled account seeded in Stage 0. Roughly
55% of those sessions skip the auth endpoint entirely because the JWT is still
live — these sessions emit a synthetic `resume_session` step instead of `login`.
The remaining 45% call `POST /auth/customer/emailpass` normally (token expired).

**Auth-required session types only ever use a REAL pooled account.** Cart,
checkout, and profile flows (`returningCheckout`, `multiItemCheckout`,
`cartAbandon`, `checkoutAbandon`, `stockOutCheckout`, `profileMgmt`, returning
`bounce`/`browse`, cart-bearing `directLanding`) call `state.drawAccount()` and
**degrade to a guest browse when the pool is empty** — they never synthesize an
account. A synthesized email was never registered, so `loginExisting` would `401`,
the session would run cart/checkout/`customers/me` calls with no token (a cascade
of `401`s and `/store/carts/undefined/...`), and Phase 7 would then mine that
unauthenticated traffic as a spurious `guest_shopper` "broken checkout" flow.
Persona is derived from observed auth behaviour, so the only correct fix is to
stop emitting traffic that lies about its identity — never to teach the classifier
the session-type tag (a debug-only field, hard constraint #2). This mirrors the
long-standing `cartWallConversion` rule.
This produces three distinct log patterns for Phase 7 to distinguish:

1. `register` only (Stage-0 signup-only sessions)
2. `login` only (returning customer, fresh token)
3. `resume_session` (returning customer, JWT reuse — no auth endpoint hit)

### Checkout abandonment weighting

`checkoutAbandon` and the abort paths in `returningCheckout` cut the checkout
sequence at a Baymard Institute–weighted point rather than uniformly:

| Step abandoned at | Probability |
| ----------------- | ----------- |
| Address entry     | 25%         |
| Shipping selection| 15%         |
| Payment           | 60%         |

Override the profile defaults with `MIX_PROFILE`, `TRAFFIC_TOTAL_SESSIONS`,
`ACCOUNT_POOL_SIZE`, and the `TRAFFIC_VALID_PROMO` / `TRAFFIC_INVALID_PROMO`
codes in `.env.example`.
