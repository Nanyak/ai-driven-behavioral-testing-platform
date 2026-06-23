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

export type SchemaSource = "openapi" | "openapi+observed" | "observed";

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
