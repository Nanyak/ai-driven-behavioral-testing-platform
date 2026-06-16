/**
 * Shape of a single raw Medusa log document as stored in Elasticsearch
 * (Phase 2 production-shaped hybrid log). Bodies are present only when the
 * backend ran with LOG_CAPTURE_BODIES=true.
 */
export interface RawLogDoc {
  timestamp: string;
  session_id?: string;
  trace_id?: string;
  request_id?: string;
  method?: string;
  endpoint?: string;
  event?: string;
  status?: number;
  user_role?: string | null;
  user_id?: string | null;
  source?: string;
  // Bodies-on enrichment only.
  request_payload?: unknown;
  response_body?: unknown;
}

/** A normalized JWT-derived role, used as Phase 7 validation ground truth only. */
export type ObservedRole = "guest" | "customer" | "admin";

/** One step in a session-flow record (Phase 6 data contract). */
export interface FlowStep {
  method: string;
  endpoint: string;
  event: string | null;
  status: number;
  trace_id: string | null;
  timestamp: string;
  request_payload: unknown;
  has_error: boolean;
}

/** A session-flow record — the primary Phase 6 output (Phase 6 data contract). */
export interface SessionFlow {
  session_id: string;
  started_at: string;
  ended_at: string;
  /**
   * Raw JWT roles observed in the session, highest-privilege last. VALIDATION
   * GROUND TRUTH ONLY — Phase 7 must never feed this to the classifier (plan §10.3).
   */
  role_observed: ObservedRole[];
  steps: FlowStep[];
}

/**
 * A candidate golden response — the OBSERVED HALF of the ADR 0001 intersection.
 * Phase 8 is authoritative (OpenAPI spec); this only snapshots what was seen in
 * logs and is empty when the backend ran bodies-off.
 */
export interface GoldenCandidate {
  endpoint: string; // "METHOD /normalized/endpoint"
  expected_status: number;
  expected_schema: SchemaNode;
  ignore_fields: string[];
  schema_source: "observed";
  captured_at: string;
  source_sessions: string[];
}

/** A recursive observed-schema snapshot: leaf type tags or nested field maps. */
export type SchemaLeaf =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object"
  | "ignored";

export type SchemaNode = SchemaLeaf | { [key: string]: SchemaNode };
