/**
 * Golden response types (ADR 0001, ADR 0004).
 *
 * `SchemaNode`/`SchemaLeaf` are kept type-identical to
 * `services/log-ingestion/src/types.ts` so the log-ingestion observed
 * `GoldenCandidate` snapshots feed straight into `schema-merge.ts` without
 * conversion.
 */

export type SchemaLeaf =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object"
  | "ignored";

export type SchemaNode = SchemaLeaf | { [key: string]: SchemaNode };

// "types" = derived from the installed, version-matched @medusajs/types .d.ts
// declarations (services/golden/src/types-source) rather than Medusa's drifted
// published OpenAPI. oas_ref is then "@medusajs/types#<TypeName>".
export type SchemaSource = "openapi" | "openapi+observed" | "observed" | "types";

export type ValueFormat = "uuid" | "email" | "date-time";

/**
 * A VALUE-level invariant (Tier A value-level golden, ADR 0001). Unlike
 * `SchemaNode` (which asserts field EXISTENCE + JSON TYPE), a `ValueRule`
 * asserts the field's CONTENT against a constraint the OpenAPI contract itself
 * declares (`enum`/`const`/`minimum`/`maximum`/`format`). The spec is the
 * author, so promotion is deterministic and judgement-free.
 *
 * `path` is dotted, with `[]` marking "for every element of this array"
 * (e.g. `products[].status`). Rules are evaluated against the live body in
 * `compare/compare.ts`; a rule never fires on an absent or `null` value —
 * existence is the schema layer's job, keeping the two layers orthogonal.
 */
export type ValueRule =
  | { path: string; kind: "enum"; values: (string | number | boolean)[] }
  | { path: string; kind: "const"; value: string | number | boolean }
  | { path: string; kind: "range"; min?: number; max?: number }
  | { path: string; kind: "format"; format: ValueFormat };

/**
 * The golden response format. One file per
 * `(endpoint, expected_status)` under `golden-responses/`.
 *
 * OAS provenance fields (`oas_operation_id`, `oas_ref`, `oas_version`) are
 * `null` when `schema_source === "observed"` (no spec entry existed for this
 * operation/status, so the golden fell back to observed-only).
 */
export interface GoldenResponse {
  endpoint: string;
  expected_status: number;
  expected_schema: SchemaNode;
  ignore_fields: string[];
  schema_source: SchemaSource;
  oas_operation_id: string | null;
  oas_ref: string | null;
  /** A content hash when the spec is unversioned, otherwise its `info.version`. */
  oas_version: string | null;
  /**
   * Spec-sourced value invariants (Tier A). Empty for `schema_source:
   * "observed"` (no OAS entry to lift constraints from). Rules whose path lands
   * on an `ignore_fields` field are filtered out so the value layer stays
   * consistent with the type layer (a field is never value-checked if its type
   * is ignored).
   */
  value_rules: ValueRule[];
  captured_at: string;
  source_sessions: string[];
}

/** The observed half of the ADR 0001 intersection (log-ingestion output). */
export interface GoldenCandidate {
  endpoint: string;
  expected_status: number;
  expected_schema: SchemaNode;
  ignore_fields: string[];
  schema_source: "observed";
  captured_at: string;
  source_sessions: string[];
}
