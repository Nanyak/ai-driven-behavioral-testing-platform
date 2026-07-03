/**
 * Global ignore-fields list. Single auditable source — kept IDENTICAL to
 * `services/log-ingestion/src/pipeline.ts`
 * `IGNORE_FIELDS`. Do not edit one without the other until log-ingestion is
 * re-pointed at this module (log-ingestion still has its own copy for now).
 */
export const GLOBAL_IGNORE_FIELDS: readonly string[] = [
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "metadata",
  "token",
  "cart_id",
  "order_id",
  // Conditional FK ids: Medusa emits these only once an address is attached to a
  // cart, so a single flat golden schema can't pin them (present in checkout
  // flows, absent in address-less cart updates). Volatile ids like cart_id/order_id.
  "shipping_address_id",
  "billing_address_id",
  "trace_id",
  "session_id",
];

/** Keyed by `"METHOD /normalized/endpoint"`; values are dotted field paths relative to the response body root. */
export const PER_ENDPOINT_IGNORE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "POST /store/payment-collections": ["payment_collection.id"],
};

export function ignoreFieldsFor(endpoint: string): string[] {
  const additions = PER_ENDPOINT_IGNORE_FIELDS[endpoint] ?? [];
  return [...new Set([...GLOBAL_IGNORE_FIELDS, ...additions])];
}

// Checks only the top-level field name. Per-endpoint additions are dotted
// paths and are checked separately by normalize.ts/schema-extract.ts against
// the full field path.
export function isGloballyIgnored(fieldName: string): boolean {
  return GLOBAL_IGNORE_FIELDS.includes(fieldName);
}
