# ADR 0003 — Order reversals (return / refund / cancel) are admin-only and order-state-gated

- **Status:** Accepted
- **Date:** 2026-06-16
- **Affects:** Phase 5 (traffic generator), Phase 7 (behavioral modeling), storefront (`apps/storefront`)

## Context

The storefront exposes **no customer-facing order reversal**. The order page is
read-only (native order view + Shopee-style stage badges + "Buy again") — see the
order-action decision recorded in project memory and `apps/storefront/src/utils/orderStatus.ts`.
Medusa's store API has no customer order-cancel endpoint, and `POST /store/returns`
requires a return shipping `option_id` the seed does not provide, so a customer
return call always 400s. Order lifecycle is handled by an operator in the Medusa
admin (`/app`).

The Phase 5 traffic generator originally modelled returns as a **customer**
`POST /store/returns` call (flow E) settled by an admin refund (F3). With the
storefront reversal removed, that customer call was dead — every E session 4xx'd,
the admin refund hit a non-existent `POST /admin/orders/{id}/refunds` (404), and
the `returns filed` / `cross-role linked refunds` acceptance gates sat at 0.

Probing the live Medusa 2.15.5 build established the real constraints:

- **Returns are admin-only and fulfillment-gated.** A return is created with
  `POST /admin/returns` (must carry a `location_id` or `receive/confirm` 500s with
  "Cannot receive the Return at location null") and only covers **fulfilled**
  quantities — "Cannot request to return more items than what was fulfilled." The
  refund is settled through `request-items → request → receive → receive-items →
  receive/confirm`, **not** a direct refund endpoint.
- **Cancel is unfulfilled-only.** `POST /admin/orders/{id}/cancel` succeeds on an
  unfulfilled order (reversing the authorized payment) but 400s on a fulfilled one
  ("All fulfillments must be canceled before canceling an order").

These are two genuinely distinct real-world reversal archetypes: *changed my mind
before it shipped* (cancel) vs *received it and sent it back* (return + refund).

## Decision

1. **The storefront stays read-only for reversals.** No customer cancel/return/
   refund is reintroduced. Do not add a customer reversal call to the traffic
   generator's store sessions — flow E is a **read-only return inquiry**
   (`login → view orders → view a fulfilled order`) that only flags the order for
   admin settlement.
2. **All reversals are admin-operated**, modelling the operator in `/app`:
   - **F3 return + refund** runs the full admin return lifecycle on a **fulfilled**
     order.
   - **F5 cancel** cancels an **unfulfilled** order.
3. **Stage 2 runs in two ordered waves** so the state gates above are satisfiable:
   **2a** fulfills orders (F2); **2b** runs the read-only inquiry (E), the return
   path (F3) on fulfilled orders, and the cancel path (F5) on unfulfilled orders.
4. **Cross-role linkage** is an `order_id` that appears in both a customer session
   (placement in Stage 1, and/or the read-only inquiry in E) and the admin
   return+refund sequence — joined as `returnPool ∩ refundedOrderIds`. The customer
   does not file the return; the admin does, on the customer's behalf.

## Consequences

- Phase 7 mines two reversal archetypes (return-after-fulfillment, cancel-before-
  fulfillment), both admin-role, linked to a customer-role order by `order_id`.
- The generator must fulfill before it can return; the `adminFulfill` floor is
  auto-topped above the return floor (`adminRefund + 3`) so Stage 2b always has
  fulfilled orders.
- These admin endpoints are version-sensitive across Medusa 2.x minors. They are
  marked `// VERIFY against live backend` and degrade to a logged non-2xx rather
  than crashing.
- If a future requirement needs a customer-initiated return, it requires BOTH a
  seeded return shipping option (for `POST /store/returns`) AND an admin widget
  that surfaces it — and, being outside Medusa's published OpenAPI, a supplemental
  OAS fragment merged in Phase 8 (the assertion oracle is the OpenAPI contract, ADR 0001).
