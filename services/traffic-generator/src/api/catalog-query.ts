import type { ApiResponse } from "../http/client.js";

export interface ProductLite {
  id: string;
  variantId?: string;
}

export type SortOrder = "title" | "-title" | "created_at" | "-created_at";

export const PRODUCT_FIELDS =
  "*variants.calculated_price,+variants.inventory_quantity,*variants.options,*options";

/** Attaches `region_id` when known since prices are region-scoped. */
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
