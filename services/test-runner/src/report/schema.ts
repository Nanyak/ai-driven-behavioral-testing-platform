// Built from the NormalizedRunResult (collect.ts), never from
// Playwright shapes directly. `trace_id` is OPTIONAL and omitted when absent
// upstream — behavior-engine candidates carry `source_sessions` but no trace
// id; we never invent one (see collect.ts).
import type { SchemaDiffEntry } from "../../../golden/src/compare.js";
import type { RunTotals } from "../collect.js";

/**
 * Golden schema diff rolled up to path lists per kind. The full expected/actual
 * detail lives in the normalized result; the report keeps the stakeholder-facing
 * summary.
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
  endpoint: string;
  failures: number;
}

export interface FailureEntry {
  flow_name: string;
  persona: string;
  flow_signature: string | null;
  /** "(no request step)" when the test failed before any request. */
  endpoint: string;
  expected_status: number | null;
  actual_status: number | null;
  golden_diff: GoldenDiffSummary | null;
  duration_ms: number;
  source_sessions: string[];
  /** Omitted when absent upstream — never invented. */
  trace_id?: string | null;
  failure_message: string | null;
}

export interface Report {
  run_id: string;
  generated_at: string;
  status: "green" | "red";
  totals: RunTotals;
  by_persona: PersonaRollup[];
  by_flow: FlowRollup[];
  endpoint_failures: EndpointFailure[];
  failures: FailureEntry[];
}

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
