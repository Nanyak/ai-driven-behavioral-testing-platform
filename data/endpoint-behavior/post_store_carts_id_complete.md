---
endpoint: POST /store/carts/{id}/complete
workflow: cart/workflows/complete-cart.js
source_hash: 7305029b7e6e43f0768d15f87bcd43471f1e44724f213baf7986b5e270c4b256
generated_at: 2026-06-26T17:45:12.682Z
---

## Guards
- The cart must exist and have at least one line item (`validateCartItemsStep` on `cart.items`) — an empty cart fails.
- The cart must have an active/valid payment session (`validateCartPaymentsStep`); the workflow authorizes `paymentSessions[0]`, so a missing or non-authorizable session blocks order placement.
- When placing the order for the first time, every cart shipping method must resolve to a valid shipping option/profile (`validateShippingStep`).
- The cart must not already be locked by a concurrent completion (`acquireLockStep`, 30s wait / 120s ttl) — overlapping completes for the same cart are serialized.
- Custom `validate` hook may impose additional preconditions before any work runs.

## Side effects
- Creates a new order with `status === "pending"` (`OrderStatus.PENDING`), copying items, shipping methods, addresses, currency, email, promo codes, and credit lines from the cart.
- Reserves inventory for the ordered variants (`reserveInventoryStep`).
- Authorizes the payment session and, for any captures, records order transactions (`reference: "capture"`).
- Registers promotion usage for item and shipping adjustment codes.
- Emits the `OrderWorkflowEvents.PLACED` (`order.placed`) event at CRITICAL priority.
- Sets `cart.completed_at` on the cart and creates links order↔cart, order↔promotion(s), and order↔payment_collection.
- Idempotent: if an `order_cart` link already maps the cart to an `order_id`, it returns that existing order id and re-runs none of the above — no duplicate order, inventory, or capture.

## Success discriminator
- The API route wraps the workflow's `{ id }` output as `{ type: "order", order: {...} }`. Success is proven by `type === "order"` plus an `order` object whose `order.id` is set and `order.status === "pending"`.
- A bare HTTP 200 does NOT prove placement: the same 200 also carries the failure body below. Assert on `type` / presence of `order`, not on status code alone.
- Note the newly placed order is `pending`, not `"completed"`/`"canceled"` — do not assert a "completed" order status here.

## Failure shape
- Payment-authorization (and similar post-creation) failures surface as **HTTP 200** with `{ type: "cart", cart: {...}, error }` — `type === "cart"` (no `order`) signals the cart was not converted; inspect `error`/`error.message`.
- Guard failures (`validateCartItemsStep`, `validateCartPaymentsStep`, `validateShippingStep`, or the `validate` hook throwing `MedusaError`) surface as **4xx** with a body of `{ type, message }` (e.g. `type: "invalid_data"` / `"not_allowed"`, with a human-readable `message`); no `order` is present.
