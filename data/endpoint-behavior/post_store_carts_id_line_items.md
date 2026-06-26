---
endpoint: POST /store/carts/{id}/line-items
workflow: cart/workflows/add-to-cart.js
source_hash: 79e2b012f5074cf338985592e1c0c67ae0809796f8be96e83b00b651b2928049
generated_at: 2026-06-26T17:43:48.238Z
---

## Guards
- Cart must exist: `get-cart` queries `cart` by `id` with `throwIfKeyNotFound: true`, so an unknown `cart_id` aborts before any mutation (surfaces as a 404 `Cart id <id> was not found`).
- `validateCartStep` enforces the cart is in a mutable state — a cart with `completed_at` set (already completed/converted to an order) is rejected; line items cannot be added to a completed cart.
- Each requested `variant_id` must resolve to an existing variant (variants are fetched/validated); a missing variant fails the workflow.
- `validateLineItemPricesStep` requires every resolved line item to have a usable price — if a variant has no `calculated_price.calculated_amount` and no explicit `unit_price` was supplied, the item has no price and the workflow throws.
- `confirmVariantInventoryWorkflow` enforces inventory/sales-channel availability: the variant must be stocked and sellable in the cart's `sales_channel_id` for the requested quantity, otherwise insufficient-inventory failure.

## Side effects
- Creates new line items (`createLineItemsStep`) and/or increments quantity on existing matching line items (`updateLineItemsStep`) on the cart — quantities for a repeated variant merge rather than duplicate.
- Recomputes cart pricing/promotions/taxes/totals via `refreshCartItemsWorkflow` (line-item and cart totals are refreshed after items change).
- Resolves and stores per-item `unit_price` (calculated price unless a custom `unit_price` was passed) and tax-inclusivity, plus translated line-item titles by `cart.locale`.
- Emits the `cart.updated` event for `cart.id`.
- Acquires/releases a cart-scoped lock around the mutation (concurrency guard, not observable in body).
- Does NOT decrement inventory or capture payment — inventory is only confirmed/reserved-as-checked here, not deducted; no order is created.

## Success discriminator
- The route returns the refreshed cart, so success is proven by `cart.id` matching the requested id and the target variant being present in `cart.items[]` — i.e. an item where `cart.items[*].variant_id === <requested variant_id>` exists with the expected `quantity` (or incremented quantity if it pre-existed).
- The added/updated item carries a resolved `unit_price` (number) and `cart.items[*].product_id`/`title` populated; cart aggregate fields (`item_total`/`total`/`subtotal`) reflect the new item.
- A 200 alone does NOT prove the item was added: assert the specific `items[]` entry and updated totals, not just the status code, since the body is always a cart object regardless.

## Failure shape
- Inventory insufficiency / not sellable in the sales channel surfaces as a 4xx with `{ type: "not_allowed" | "insufficient_inventory", message }` (no item added; `cart.items[]` unchanged) — the failure is in the error body, not a flag on the cart.
- Unknown `cart_id` → HTTP 404 with `{ type: "not_found", message: "Cart id <id> was not found" }`.
- Unknown/invalid `variant_id`, missing price, or invalid quantity → HTTP 400 with `{ type: "invalid_data" | "not_found", message }`.
- Validation-hook or price-validation throws surface as 4xx with `{ type, message }` (Medusa error envelope: `type`, `message`, optional `code`); the cart is not mutated.
- Because the success body is always a `cart`, a partial/failed add still returns a cart shape — distinguish failure by the presence of the error envelope and by the absence of the expected `items[]` entry / unchanged totals rather than by HTTP status alone.
