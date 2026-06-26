---
endpoint: POST /store/carts/{id}
workflow: cart/workflows/update-cart.js
source_hash: 7db35c93a35a327094965647d7883587b0a5f66bf0094c3307f3184b89294752
generated_at: 2026-06-26T17:43:27.503Z
---

## Guards
- Cart `id` must reference an existing cart — `useQueryGraphStep` runs with `throwIfKeyNotFound: true`, so an unknown id yields a not-found error (no cart in body).
- `validateCartStep` must pass — the cart must not already be completed/in a terminal state.
- The resolved sales channel must pass `validateSalesChannelStep` — a disabled (or missing) sales channel halts the workflow.
- If `region_id` is supplied, that region must exist (`get-region` also uses `throwIfKeyNotFound: true`).
- If `shipping_address.country_code` is supplied, the country must belong to the (new or existing) region; otherwise `INVALID_DATA`: `Country with code <X> is not within region <name>`.

## Side effects
- Persists the cart updates via `updateCartsStep` (e.g. `region_id`, `currency_code`, `email`, `sales_channel_id`, `shipping_address`).
- Email handling: registered customers (`has_account === true`) get the submitted `email`; otherwise `email` falls back to the resolved customer's email and `customer_id` is set.
- On region change: `currency_code` is reset to the new region's currency; `shipping_address` is auto-set to the sole country when the region has exactly one country, and is set to `null` when no valid country code remains.
- On region change: deletes all line items where `is_custom_price === true`.
- Emits `CartWorkflowEvents.UPDATED` always; emits `CartWorkflowEvents.REGION_UPDATED` only when `region_id` actually changes.
- Runs `refreshCartItemsWorkflow` — recalculates line-item prices/totals, applies/refreshes `promo_codes`, and (when region changed) force-refreshes; this re-derives `items`, `total`, `subtotal`, `tax_total`, `discount_total`, `promotions`.

## Success discriminator
- The response body is the refreshed **cart** object (e.g. `cart.id` present); there is no `type` discriminator — success means the cart reflects the submitted changes.
- Proof a field actually took effect: check the echoed value, not just HTTP 200 — `cart.region_id === <new region_id>`, `cart.currency_code === <region currency>`, `cart.email === <new email>`, `cart.shipping_address.country_code === <expected iso_2>`.
- Promo application is proven by `cart.promotions[]` containing the code and a non-zero `cart.discount_total` / adjusted `cart.total` — **not** by the 200 alone.
- Region change is proven by the new `cart.currency_code` and a cleared/auto-filled `cart.shipping_address` (e.g. `null`, or `{ country_code }` only) plus absence of previously custom-priced items.

## Failure shape
- Invalid/unknown promo codes do **not** error: the endpoint returns 200 with a cart whose `cart.promotions[]` simply omits the bad code and whose `discount_total` is unchanged — assert on the missing promotion, not on status.
- Country-not-in-region returns 4xx with `{ type: "invalid_data", message: "Country with code <X> is not within region <name>" }`.
- Unknown cart id or unknown `region_id` returns 404-style `{ type: "not_found", message: ... }`.
- A disabled/invalid sales channel surfaces as a 4xx MedusaError in the body (`type`, `message`) from `validateSalesChannelStep`.
- All 4xx bodies carry Medusa's standard error fields: `message` and `type` (with `code` when set); no `cart` object is returned on these errors.
