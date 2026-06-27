/**
 * Maps a tested `METHOD /path` operation to the `@medusajs/types` response type
 * its 200 returns. This is the machine-readable link that Medusa's stripped
 * `@oas` JSDoc annotations used to provide; we curate it for the endpoints this
 * platform actually exercises. `{id}` placeholders match the generated specs.
 *
 * Only 2xx happy-path responses are mapped — error envelopes (401/404/400) come
 * from the gate overlay / observed goldens, not the entity types.
 */
export const ENDPOINT_RESPONSE_TYPE: Readonly<Record<string, string>> = {
  // --- store reads (currently webpage-OAS-sourced) ---
  "GET /store/products": "StoreProductListResponse",
  "GET /store/products/{id}": "StoreProductResponse",
  "GET /store/regions": "StoreRegionListResponse",
  "GET /store/product-categories": "StoreProductCategoryListResponse",
  "GET /store/payment-providers": "StorePaymentProviderListResponse",
  "GET /store/shipping-options": "StoreShippingOptionListResponse",
  // --- admin reads ---
  "GET /admin/orders": "AdminOrderListResponse",
  "GET /admin/orders/{id}": "AdminOrderResponse",
  "GET /admin/products": "AdminProductListResponse",
  "GET /admin/products/{id}": "AdminProductResponse",
  "GET /admin/returns": "AdminReturnsResponse",
  "GET /admin/customers": "AdminCustomerListResponse",
  "GET /admin/stock-locations": "AdminStockLocationListResponse",
  "GET /store/orders/{id}": "StoreOrderResponse",
  // --- store cart / checkout mutations ---
  "POST /store/carts": "StoreCartResponse",
  "POST /store/carts/{id}": "StoreCartResponse",
  "POST /store/carts/{id}/line-items": "StoreCartResponse",
  "POST /store/carts/{id}/shipping-methods": "StoreCartResponse",
  "POST /store/payment-collections": "StorePaymentCollectionResponse",
  "POST /store/payment-collections/{id}/payment-sessions": "StorePaymentCollectionResponse",
  // --- admin order / return lifecycle mutations ---
  "POST /admin/orders/{id}/cancel": "AdminOrderResponse",
  "POST /admin/orders/{id}/fulfillments": "AdminOrderResponse",
  "POST /admin/products/{id}": "AdminProductResponse",
  "POST /admin/returns": "AdminReturnResponse",
  "POST /admin/returns/{id}/request": "AdminReturnPreviewResponse",
  "POST /admin/returns/{id}/request-items": "AdminReturnPreviewResponse",
  "POST /admin/returns/{id}/receive": "AdminReturnPreviewResponse",
  "POST /admin/returns/{id}/receive-items": "AdminReturnPreviewResponse",
  "POST /admin/returns/{id}/receive/confirm": "AdminReturnResponse",
};

/** Look up the response type for a `METHOD /path` op (200 only), or null. */
export function responseTypeFor(method: string, endpoint: string): string | null {
  return ENDPOINT_RESPONSE_TYPE[`${method.toUpperCase()} ${endpoint}`] ?? null;
}
