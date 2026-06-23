/**
 * Regression Triage Agent — types.
 *
 * Triage is ADVISORY ONLY. It reads the deterministic report (report.json) plus
 * the normalized run (normalized.json) and attaches a per-failure VERDICT —
 * is this a real regression, intentional contract drift, or a test artifact? It
 * NEVER mutates report.json, the golden oracle, or the gate (ADR 0001/0005):
 * the output is a sidecar (reports/triage.json) the HTML merges at render time.
 */

/** What the triage agent decided a failure most likely is. */
export type Verdict =
  | "real_regression" // behaviour broke: stable endpoint 2xx->5xx, or a required field vanished
  | "contract_drift" //  SUT intentionally changed; the golden is stale (often additive)
  | "test_artifact" //   generator/spec issue: setup threw, auth gate, captured-id dependency, flake
  | "uncertain"; //      insufficient evidence -> a human should look

export type Confidence = "low" | "medium" | "high";

/** The evidence assembled for ONE failing step, fed to the heuristic or LLM. */
export interface EvidenceBundle {
  failure_id: string;
  persona: string;
  flow_name: string;
  flow_signature: string | null;
  /** "POST /store/carts/{id}/complete" — method + endpoint, as the report carries it. */
  endpoint: string;
  method: string;
  expected_status: number | null;
  actual_status: number | null;
  golden_diff: { missing: string[]; unexpected: string[]; type_changed: string[] } | null;
  /** Subset of golden_diff.missing the OAS marks `required` (v2b). [] when none/unknown. */
  required_missing: string[];
  failure_message: string | null;
  /** Capped live response body excerpt (v2a), when captured. */
  response_body_excerpt: string | null;
  source_sessions: string[];
}

export interface TriageVerdict {
  failure_id: string;
  verdict: Verdict;
  confidence: Confidence;
  rationale: string;
  recommended_action: string;
  evidence: {
    endpoint: string;
    expected_status: number | null;
    actual_status: number | null;
    diff_paths: string[];
    required_missing: string[];
  };
}

export interface TriageReport {
  run_id: string;
  generated_at: string;
  /** The model that produced these verdicts, or "offline-heuristic". */
  model: string;
  verdicts: TriageVerdict[];
}

export const VERDICTS: readonly Verdict[] = [
  "real_regression",
  "contract_drift",
  "test_artifact",
  "uncertain",
];

export const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];
