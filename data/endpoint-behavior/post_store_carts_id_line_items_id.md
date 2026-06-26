---
endpoint: POST /store/carts/{id}/line-items/{id}
workflow: cart/workflows/update-line-item-in-cart.js
source_hash: 46e0005e06c344208e283b0dec195e613585610587d41e1fefea911d57173b6e
generated_at: 2026-06-26T17:44:14.725Z
---

## Guards
- The cart `input.cart_id` must exist — `useQueryGraphStep` runs with `throwIfKeyNotFound: true`, so a missing cart yields a not-found error (no cart row → no success).
- The target line item `input.item_id` must already be present in `cart.items`; otherwise the workflow throws `MedusaError` type `NOT_FOUND` with message `Line item with id: {item_id} was not found`.
- `validateCartStep` must pass — the cart must be in an updatable state (e.g. not already completed).
- When not removing the item, the variant must have a resolvable price: `validateVariantPricesStep` rejects variants with no calculated price, and a final guard throws `INVALID_DATA` `Line item {title} has no unit price` if no `unit_price` can be determined.
- `confirmVariantInventoryWorkflow` must pass — requested `update.quantity` must be satisfiable by available inventory in the cart's sales channel (unless the item is being removed).
- A cart-scoped lock on `cart_id` must be acquirable (2s timeout) for the update to proceed.

## Side effects
- If `update.quantity === 0`, the line item is **deleted** from the cart (`deleteLineItemsWorkflow`) — `cart.items` will no longer contain `item_id`.
- Otherwise the line item is updated: `quantity` set to `update.quantity`; `unit_price` set to the request's `unit_price` (when provided) or recalculated from the variant's `calculated_price.calculated_amount`; `is_custom_price` becomes `true` when a `unit_price` was supplied; `is_tax_inclusive` may flip based on the variant's calculated price.
- `refreshCartItemsWorkflow` recomputes cart-level state: item totals, taxes, promotions/adjustments, and cart totals (`subtotal`, `tax_total`, `total`, etc.).
- Emits a `cart.updated` event (`CartWorkflowEvents.UPDATED`) with `{ id: cart_id }`.
- Releases the cart lock.

## Success discriminator
- The workflow itself returns `undefined` (`WorkflowResponse(void 0, ...)`); the success payload is the **re-fetched cart** returned by the API route as `{ cart }`. A bare 200 only proves the request was processed — it does not prove the mutation took effect.
- Assert on the cart contents, not status:
  - Quantity change: `cart.items[].id === item_id` with `cart.items[].quantity === <new quantity>`.
  - Removal (`quantity: 0`): `cart.items` contains **no** entry with `id === item_id`.
  - Price/tax: updated item's `unit_price` and recomputed `cart.total` / `cart.item_total` reflect the change.

## Failure shape
- This endpoint surfaces failures as HTTP error status with a Medusa error body, not as a `200` discriminated union (no `{ type, error }` success/failure split is produced here).
- Body shape on error: `{ type, message }` (Medusa may also include `code`). Field paths to assert: `message` (string), `type` (string).
- Cart not found / line item not found → `type === "not_found"`; line-item case `message === "Line item with id: {item_id} was not found"` (typically HTTP 404).
- No resolvable price → `type === "invalid_data"`, `message === "Line item {title} has no unit price"` (typically HTTP 400).
- Insufficient inventory for the requested `quantity` → error raised by `confirmVariantInventoryWorkflow` (insufficient-inventory error in `message`).
- Lock acquisition failure on a concurrently-mutating cart surfaces as an error rather than a successful cart body.
