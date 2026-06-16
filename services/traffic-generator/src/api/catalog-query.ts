import type { ApiResponse } from "../http/client.js";

/** A product reduced to the ids a shopping session needs (id + first variant). */
export interface ProductLite {
  id: string;
  variantId?: string;
}

/** Valid `?order=` values for `GET /store/products` (Theme 2 catalog sort). */
export type SortOrder = "title" | "-title" | "created_at" | "-created_at";

/** Field selection sent with every `/store/products` query. */
export const PRODUCT_FIELDS =
  "*variants.calculated_price,+variants.inventory_quantity,*variants.options,*options";

/**
 * Build the query string for a `/store/products` list/detail call: always sets
 * `fields`, attaches `region_id` when known (prices are region-scoped), and folds
 * in any extra params (q, limit, offset, order, category_id[]). Centralizes the
 * boilerplate that otherwise repeats across every catalog read.
 */
export function productListParams(
  regionId: string | undefined,
  extra: Record<string, string> = {}
): URLSearchParams {
  const params = new URLSearchParams({ fields: PRODUCT_FIELDS, ...extra });
  if (regionId) {
    params.set("region_id", regionId);
  }
  return params;
}

/** Map a `/store/products` response body to ProductLite[], or [] if malformed. */
export function mapProducts(res: ApiResponse): ProductLite[] {
  if (!res.ok || !Array.isArray(res.body?.products)) {
    return [];
  }
  // `any`: Medusa product-list item — only the id and first variant id are read.
  return res.body.products.map((p: any) => ({
    id: p.id,
    variantId: p?.variants?.[0]?.id,
  }));
}
