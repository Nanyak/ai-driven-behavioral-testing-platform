/**
 * Bodies are present only when the backend ran with LOG_CAPTURE_BODIES=true.
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

export type ObservedRole = "guest" | "customer" | "admin";

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

export interface SessionFlow {
  session_id: string;
  started_at: string;
  ended_at: string;
  /**
   * Highest-privilege last. VALIDATION GROUND TRUTH ONLY — the behavior engine
   * must never feed this to the classifier.
   */
  role_observed: ObservedRole[];
  steps: FlowStep[];
}

/**
 * OBSERVED HALF of the ADR 0001 intersection. The golden service is authoritative
 * (OpenAPI spec); this only snapshots what was seen in logs and is empty
 * when the backend ran bodies-off.
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

export type SchemaLeaf =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object"
  | "ignored";

export type SchemaNode = SchemaLeaf | { [key: string]: SchemaNode };
