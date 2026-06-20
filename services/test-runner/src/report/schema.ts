/**
 * schema.ts (Phase 11 plan step #1). The stakeholder-report types — the shape
 * of `reports/report.json`. Built from the Phase 10 NormalizedRunResult
 * (collect.ts), never from Playwright shapes directly.
 *
 * Field provenance (plan §"Required fields"): totals + per-persona + per-flow +
 * endpoint failures + expected/actual status + golden diff + source session ids.
 * `trace_id` is OPTIONAL and omitted when absent upstream — behavior-engine
 * candidates carry `source_sessions` but no trace id; we never invent one
 * (see collect.ts and the Phase 11 checklist note).
 */
import type { SchemaDiffEntry } from "../../../golden/src/compare.js";
import type { RunTotals } from "../collect.js";

/**
 * Golden schema diff rolled up to path lists per kind (plan §schema example:
 * `{ "missing": [], "unexpected": ["error"], "type_changed": [] }`). The full
 * expected/actual detail lives in the normalized result; the report keeps the
 * stakeholder-facing summary.
 */
export interface GoldenDiffSummary {
  missing: string[];
  unexpected: string[];
  type_changed: string[];
}

export interface PersonaRollup {
  persona: string;
  passed: number;
  failed: number;
  skipped: number;
}

export interface FlowRollup {
  flow_name: string;
  persona: string;
  flow_signature: string | null;
  passed: number;
  failed: number;
  skipped: number;
}

export interface EndpointFailure {
  /** "<METHOD> <endpoint>", e.g. "POST /store/carts/{id}/complete". */
  endpoint: string;
  failures: number;
}

/** One failing step (endpoint-level), attributed to its persona + flow + source. */
export interface FailureEntry {
  flow_name: string;
  persona: string;
  flow_signature: string | null;
  /** "<METHOD> <endpoint>", or "(no request step)" when the test failed before any request. */
  endpoint: string;
  expected_status: number | null;
  actual_status: number | null;
  golden_diff: GoldenDiffSummary | null;
  duration_ms: number;
  /** Always present (plural upstream); see the Phase 11 checklist note. */
  source_sessions: string[];
  /** Omitted when absent upstream — never invented. */
  trace_id?: string | null;
  /** Readable expected-vs-actual / resolver-error message, when the step carried one. */
  failure_message: string | null;
}

export interface Report {
  run_id: string;
  generated_at: string;
  /** Convenience verdict for the demo / CI: red when any test failed. */
  status: "green" | "red";
  totals: RunTotals;
  by_persona: PersonaRollup[];
  by_flow: FlowRollup[];
  endpoint_failures: EndpointFailure[];
  failures: FailureEntry[];
}

/** Roll a structured golden diff up into per-kind path lists, or null when empty. */
export function summarizeGoldenDiff(diff: SchemaDiffEntry[] | null | undefined): GoldenDiffSummary | null {
  if (!diff || diff.length === 0) return null;
  const summary: GoldenDiffSummary = { missing: [], unexpected: [], type_changed: [] };
  for (const entry of diff) {
    switch (entry.kind) {
      case "missing_field":
        summary.missing.push(entry.path);
        break;
      case "unexpected_field":
        summary.unexpected.push(entry.path);
        break;
      case "type_changed":
        summary.type_changed.push(entry.path);
        break;
    }
  }
  return summary;
}
