# ADR 0006 — The emergent `requires_auth` signal extends from cart mutations to auth-gated reads

- **Status:** Accepted
- **Date:** 2026-06-21
- **Affects:** Phase 7 (behavioral modeling / emergent persona classification)
- **Amends:** the `requires_auth` rule in `docs/phase-7-implementation-plan.md`
  (§Emergent persona derivation) and `services/behavior-engine/src/classification/attributes.ts`.
  Does **not** touch ADR 0001 (the OpenAPI/observed-status oracle) or the §guardrail.

## Context

Phase 7 derives persona from **flow content only** — `method`, `endpoint`,
`status` per step — never from the JWT `user_role` (the §guardrail; reading the
role would make classification circular). `requires_auth` originally fired on:

1. an explicit **auth/identity endpoint** (`/auth/customer/*` or `/store/customers`), or
2. a **successful (2xx) cart/checkout mutation** on `/store/carts*` or
   `/store/payment-collections*`.

Signal (2) exists because **token reuse hides the auth endpoint** (PO-2): a
returning customer who reuses a live JWT emits no `/auth/*` step, so its only
content trace of being a customer is that its gated calls *succeed*. A genuine
guest 4xx's there (the `requireCustomerAuth` gate, ADR 0004), so a **2xx is
emergent proof of a held token** — derived from endpoint + status, never the role.

**The gap.** Signal (2) was folded into cart/checkout **mutations** only. But the
same logic applies to **reads** that the backend auth-gates. A token-reuse
customer whose session is *read-only* — checking order history, viewing their
profile — emits no `/auth/*` step and no cart mutation, so the original rule
labels them `guest_shopper`. They are not guests: they are logged-in customers
whose `200` on an auth-gated read is only possible *because* a token was held.
Observed live (the 4 residual Phase 10 false-guest failures of 2026-06-21):
`GET /store/orders` and `GET /store/customers/me` returned `200` in mined
sessions, were classified guest, and then `401`'d on replay because the generator
(correctly, for a guest) sent no token.

## Decision

Extend `requires_auth` with a third, status-derived signal — the **read analog
of the cart signal**:

3. a **successful (2xx) response on an auth-gated read** — a `GET` the live
   backend returns `401` for without a customer token.

The signal is **deliberately conservative**: it fires only for reads that
genuinely `401` for an unauthenticated actor, because only then is a `2xx`
*proof* of a held token. Verified against the live backend:

| Read (guest, publishable key only) | Status | In the signal? |
| --- | --- | --- |
| `GET /store/orders` (list) | **401** | ✅ yes — 2xx ⇒ customer |
| `GET /store/customers/me` (+ sub-paths) | **401** | ✅ yes — 2xx ⇒ customer |
| `GET /store/orders/{id}` | **404**, not 401 | ❌ no — Medusa permits guest order-by-id lookup, so a 2xx does **not** prove a token |
| `GET /store/shipping-options` | **400/404** | ❌ no — cart-gated, not auth-gated; only an indirect signal via the cart |

This keeps signal (3) **sound** by the same discipline ADR/PO-2 imposes on signal
(2): *confirm the gate actually enforces (guest → 401) before trusting a 2xx.* A
read that 404s/400s for a guest is excluded — leaving genuinely ambiguous flows
(e.g. order-by-id only) as `guest_shopper`, which is the honest call when content
cannot prove a token.

Like signals (1) and (2), signal (3) only ever fires on `2xx`: a guest who pokes
`/store/orders` and gets `401` carries `has_errors`, not `requires_auth` — correct.

## Validation (measured, not asserted — Phase 7 §Validation discipline)

The classifier already emits two scored variants on the same sessions so the cart
signal's value is a measured delta, not a claim. This ADR adds a **third** scored
variant so the read signal is held to the same bar:

- `endpoint_only` — baseline (signal 1).
- `cart_signal` — baseline + signal 2 (**unchanged**; its measured delta is preserved).
- `cart_read_signal` — baseline + signals 2 **and** 3; the **production rule**.

The report carries the read signal's incremental contribution
(`read_signal.recall_lift`, `read_signal.macro_f1_delta`, both vs `cart_signal`).
Acceptance mirrors the cart signal: the read signal must be **net-positive** —
raise `registered_customer` recall without lowering macro-F1. If macro-F1 drops,
confirm the gate still enforces (guest reads `401`) before concluding it leaks.

## Consequences

- Token-reuse **read-only** customer sessions (order-history, profile) now
  classify as `registered_customer`, matching ground truth (`role_observed` =
  customer on those token-bearing calls). Phase 9 then emits the authenticated
  handshake for them, so the reads replay with a token.
- `guest_shopper` remains populated by genuine browse-only flows
  (`/store/regions`, `/store/products`, …) — the ≥1-candidate-per-non-error-persona
  gate (BA-F5) still holds.
- The signal is a **content-derived endpoint set + status check**, not a JWT read.
  The §guardrail and the "persona is emergent" claim are intact.
- **Not in scope:** flows whose only customer evidence is a guest-permitted read
  (`/store/orders/{id}` alone) stay `guest_shopper` and may still fail on replay.
  That is the sound boundary, not a bug. Separately, a candidate whose mined
  per-step statuses are internally inconsistent (e.g. `GET /me 200` + `POST /me
  401`, which no single auth context reproduces) is a **candidate-quality**
  problem, not a classification one, and is unaffected by this ADR.
- ADR 0001 is untouched: this changes *who a flow is attributed to*, never what an
  observed status *means*. Observed status remains the oracle; it is never
  rewritten to make a test pass.
