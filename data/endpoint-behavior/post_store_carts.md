---
endpoint: POST /store/carts
workflow: cart/workflows/create-carts.js
source_hash: 94899d2f4e2ab521200d4b11b39f4577cc379b8e41c3d97a5dbfaeef5c1ac18a
generated_at: 2026-06-26T17:42:59.663Z
---

## Guards
- A region must resolve: an explicit `region_id` (or any default region) must exist, otherwise the workflow throws `NOT_FOUND` ("No regions found").
- The sales channel (explicit `sales_channel_id` or default) must be valid and not disabled (`validateSalesChannelStep`).
- A customer context must resolve from `customer_id` or `email` (`findOrCreateCustomerStep`).
- Every `items[].variant_id` must be an existing variant with a price computable in the cart's currency/region.
- Inventory must be confirmable for the requested variants/quantities in the sales channel (`confirmVariantInventoryWorkflow`) — insufficient stock fails the workflow.

## Side effects
- Creates a new cart (`createCartsStep`) with its line items derived from `items`.
- May create a new customer record when `email` is given and no matching customer exists.
- Computes and attaches tax lines (`updateTaxLinesWorkflow`).
- Applies `promo_codes` to the cart and recomputes adjustments (`updateCartPromotionsWorkflow`).
- Creates/refreshes the cart's payment collection (`refreshPaymentCollectionForCartWorkflow`).
- Defaults `shipping_address.country_code` when no address was supplied and the region has exactly one country.
- Emits the `cart.created` event (`CartWorkflowEvents.CREATED`) with `{ id }`.

## Success discriminator
- The response body is the created **cart** object (API route wraps it as `{ cart }`); there is no `type` field to branch on — this endpoint always returns a cart on success, never an order.
- Proof of success: `cart.id` present (a `cart_*` id), `cart.region_id` set to the resolved region, `cart.currency_code` set (request value or region default), `cart.sales_channel_id` set, and `cart.items` reflecting each requested `variant_id`/`quantity` with unit prices.
- A 200 alone does **not** prove: that any `promo_codes` were actually valid/applied — inspect `cart.promotions` / discount adjustment fields on the items or totals to confirm a code took effect; nor that payment/tax are finalized (this only creates the cart, it does not place an order).

## Failure shape
- This workflow has **no** HTTP-200-with-error path (unlike cart completion): there is no `{ type: "cart", error }` envelope here — failures abort the workflow and surface as 4xx/5xx.
- Errors are returned as a Medusa error body with `{ type, message }` (and typically `code`):
  - missing region → `type: "not_found"`, `message: "No regions found"`.
  - unknown/invalid variant, uncomputable price, or disabled sales channel → `type: "invalid_data"` / `"not_found"` with a descriptive `message`.
  - insufficient inventory → an inventory-availability error `message` (4xx).
- No partial cart object is returned alongside an error; on failure the body contains only the error fields, not a `cart`.
