# Traffic Generator (Phase 5)

Produces a realistic, intentionally messy stream of Medusa API traffic so the
downstream behavior engine has genuine data to mine. Traffic is sampled from a
**15-leaf situation taxonomy** (plan §4) across three axes — **identity**
(guest / returning / new), **intent** (browse / buy / manage / status / return),
and **outcome** (complete / abandon / error) — and keeps the registered-customer
`register → login → checkout` sequence as a **holdout** that exists only in
LLM-varied sessions (`personas/customer-llm.ts`), never in `flows/`.

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

## Layout

```
src/
  config.ts            env loading; mix profile, weights, event probs, floors
  ids.ts               session_id / trace_id / customer-email helpers
  client.ts            HTTP wrapper, header injection (no persona header)
  state.ts             RunState: account / order / return pools, valid promo
  sampling.ts          weighted allocation + identity-split + stage map
  actions.ts           StoreSession / AdminSession — runtime ID resolution
  noise.ts             abandonment, retry, contamination, shuffling
  flows/guest.ts       guest shopper (bounce/browse/cart/checkout-abandon/buy)
  flows/returning.ts   returning customer (login-only, no register)
  flows/account.ts     order-status (D1) + profile/address management (D2)
  flows/returns.ts     customer return request against a real order (E)
  flows/admin.ts       admin catalog (F1) + fulfill (F2) + refund (F3) + support (F4)
  flows/edge.ts        edge-case 4xx/5xx flows (G)
  llm/narrative.ts     Haiku 4.5 narrative (+ offline stochastic fallback)
  llm/translate.ts     narrative -> concrete API calls
  personas/customer-llm.ts  HOLDOUT: registered-customer full checkout (C3)
  run.ts               staged orchestrator: seed -> browse&buy -> post-purchase
```

## Staged pipeline (plan §5)

Returns, reorders, order-status, fulfillment, and refunds all need **prior**
state, so the run is split into ordered stages over a shared `RunState`:

- **Stage 0 — seed.** Admin logs in and creates a valid promotion (so
  deal-seeker conversions can succeed), then `ACCOUNT_POOL_SIZE` **signup-only**
  sessions populate the returning-customer account pool.
- **Stage 1 — browse & buy.** The bulk (A/B/C/D2/F1/G). Completed checkouts push
  real orders into the order pool. Returning identities draw a pooled account and
  **log in only**.
- **Stage 2 — post-purchase.** Draws from the order pool: order-status (D1),
  returns (E), admin fulfillment (F2), and admin refund (F3) — F3 settles the
  **same `order_id`** the customer returned in E, the cross-role linkage Phase 7
  discovers. Stage 2 hard-fails loudly if the order pool is empty.

> **Stage-2 endpoint shapes need live verification.** `POST /store/returns`, the
> admin return-receive + refund sequence, fulfillment, and `POST /admin/promotions`
> vary across Medusa 2.x minors (plan §risks). They are written to best-effort
> v2 shapes, degrade to a logged 4xx rather than crashing, and are marked
> `// VERIFY against live backend`. If the acceptance report shows
> `✗ cross-role linked refunds`, check those calls against the running instance.

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
**acceptance-gate** report (holdout, guest/returning checkouts, returns,
cross-role linked refunds, promo applications) plus identity-decoupling counts.

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
| `realistic`   | 300   | benchmark-anchored (≈70% abandonment, guest ≈ half)     |
| `signal-rich` | 300   | same shape, purchase/return/refund leaves boosted        |
| `smoke`       | 40    | tiny structural check                                    |

| Group | Leaves                                          | ~Weight |
| ----- | ----------------------------------------------- | ------- |
| A     | bounce, deeper browse (no cart)                 | 38%     |
| B     | cart abandon, checkout abandon                  | 22%     |
| C     | guest / returning / **new-holdout** checkout    | 16%     |
| D     | order status, profile management                | 12%     |
| E     | returns                                         | 4%      |
| F     | admin catalog / fulfill / refund / support      | 6%      |
| G     | edge / error                                    | 2%      |

Override the profile defaults with `MIX_PROFILE`, `TRAFFIC_TOTAL_SESSIONS`,
`ACCOUNT_POOL_SIZE`, and the `TRAFFIC_VALID_PROMO` / `TRAFFIC_INVALID_PROMO`
codes in `.env.example`.
