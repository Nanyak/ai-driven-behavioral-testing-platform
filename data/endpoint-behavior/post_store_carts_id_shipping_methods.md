---
endpoint: POST /store/carts/{id}/shipping-methods
workflow: cart/workflows/add-shipping-method-to-cart.js
source_hash: 494bf134308335fea962928b88def458c76bd531c7d340c66536b10a83fa18f4
generated_at: 2026-06-26T17:44:47.741Z
---

## Guards
- Cart with `id = {id}` must exist — `useRemoteQueryStep(... throw_if_key_not_found: true)` → otherwise a not-found error (HTTP 404), not a 200.
- `validateCartStep` must pass — the cart must be in a mutable state (e.g. not already completed); a completed cart is rejected.
- Every requested `options[].id` must resolve to a shipping option actually available for this cart (`validateCartShippingOptionsStep` against the priced option list) — unknown/ineligible option ids are rejected.
- Each matched shipping option must carry a price (`validateCartShippingOptionsPriceStep`, plus the inline check requiring `shippingOption.calculated_price`) — an option without a calculated price is rejected.
- The per-option `method_data` must validate against the fulfillment provider (`validateAndReturnShippingMethodsDataStep`).

## Side effects
- Removes **all** pre-existing shipping methods on the cart (`removeShippingMethodFromCartStep` over the current `shipping_methods` ids) — this is a replace, not an append.
- Adds the new shipping method(s) (`addShippingMethodToCartStep`) with, per method: `shipping_option_id`, `amount` (from `calculated_price.calculated_amount`), `is_tax_inclusive`, `name`, and `data`.
- Recalculates cart totals via `refreshCartItemsWorkflow` (shipping totals folded into cart totals/tax).
- Emits the `cart.updated` event for the cart id.
- Acquires/releases a lock keyed on the cart id (no observable body effect).

## Success discriminator
- The workflow itself returns `void`; the route responds with the re-fetched cart: body is `{ cart }`.
- Proof of success is in `cart.shipping_methods`: it contains an entry whose `shipping_option_id` equals each requested `options[].id`, with `amount`, `name`, and `is_tax_inclusive` populated.
- Because this is a **replace**, success also means prior methods are gone — assert `cart.shipping_methods` length/contents reflect exactly the submitted options, not accumulated ones.
- Assert totals moved: `cart.shipping_total` (and `cart.total`) reflect the added `calculated_amount`.
- A bare HTTP 200 does **not** prove the requested option was selected, that stale methods were cleared, or that totals were refreshed — those must be read off `cart.shipping_methods` and the totals fields.

## Failure shape
- This workflow is transactional and **throws** on any guard violation — it does **not** return an HTTP 200 with an embedded `{ type, error }` union (unlike the cart-completion flow). There is no success-shaped failure body here.
- Failures surface as a 4xx JSON error body with `type` and `message` (and sometimes `code`):
  - Missing cart → `type: "not_found"` (HTTP 404), `message` referencing the cart id.
  - Invalid/ineligible shipping option, option lacking a price, or invalid `method_data` → `type: "invalid_data"` (HTTP 400); the price case carries `message` like `Shipping option with ID <id> do not have a price`.
