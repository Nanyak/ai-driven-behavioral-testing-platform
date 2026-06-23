/**
 * Stable failure identity, derived ONLY from deterministic report fields so the
 * id is identical between the triage evidence builder and the HTML renderer
 * (which both need to key verdicts onto failures), and stable across reruns of
 * the same failure (enabling cache reuse). Never include dynamic data (bodies,
 * timestamps, ids).
 */
import { createHash } from "node:crypto";
import type { GoldenDiffSummary } from "../report/schema.js";

export interface FailureIdParts {
  persona: string;
  flow_name: string;
  flow_signature: string | null;
  endpoint: string;
  expected_status: number | null;
  actual_status: number | null;
  golden_diff: GoldenDiffSummary | null;
}

/** Sorted union of every diff path, so two equal diffs hash equal regardless of order. */
export function diffPaths(diff: GoldenDiffSummary | null): string[] {
  if (!diff) return [];
  return [...diff.missing, ...diff.unexpected, ...diff.type_changed].sort((a, b) => a.localeCompare(b));
}

export function computeFailureId(parts: FailureIdParts): string {
  const key = [
    parts.persona,
    parts.flow_signature ?? parts.flow_name,
    parts.endpoint,
    parts.expected_status ?? "?",
    parts.actual_status ?? "?",
    diffPaths(parts.golden_diff).join(","),
  ].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
