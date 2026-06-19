/**
 * Global ignore-fields list (plan §"Global ignore-fields list"). Single
 * auditable source — kept IDENTICAL to `services/log-ingestion/src/pipeline.ts`
 * `IGNORE_FIELDS`. Do not edit one without the other until log-ingestion is
 * re-pointed at this module (deferred to a later phase per the Phase 8 brief).
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
  "trace_id",
  "session_id",
];

/**
 * Per-endpoint additions to the global list (plan: "e.g. `payment_collection.id`").
 * Keyed by `"METHOD /normalized/endpoint"`; values are dotted field paths
 * relative to the response body root.
 */
export const PER_ENDPOINT_IGNORE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "POST /store/payment-collections": ["payment_collection.id"],
};

/** Resolve the effective ignore-field set for one endpoint (global ∪ per-endpoint). */
export function ignoreFieldsFor(endpoint: string): string[] {
  const additions = PER_ENDPOINT_IGNORE_FIELDS[endpoint] ?? [];
  return [...new Set([...GLOBAL_IGNORE_FIELDS, ...additions])];
}

/**
 * Whether a top-level field name is globally ignored. Per-endpoint additions
 * are dotted paths and are checked separately by `normalize.ts`/`schema-extract.ts`
 * against the full field path, not just the leaf name.
 */
export function isGloballyIgnored(fieldName: string): boolean {
  return GLOBAL_IGNORE_FIELDS.includes(fieldName);
}
