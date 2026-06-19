/**
 * Versioning (plan §"Versioning"). Goldens carry `captured_at`. A schema
 * change in a test run is a regression BY DEFAULT — the baseline only updates
 * when the developer explicitly re-runs ingestion/refresh. No silent
 * auto-update. Also provides the `oas_version` drift hook (plan acceptance
 * bullet 7): a golden whose `oas_version` no longer matches the current spec
 * can be flagged for human review.
 */
import type { CompareResult } from "./compare.js";
import type { GoldenResponse } from "./types.js";

/** ISO-8601 stamp for a newly captured/refreshed golden. */
export function stampCapturedAt(now: Date = new Date()): string {
  return now.toISOString();
}

export interface RefreshDecision {
  /** Whether the stored golden should be replaced by the new candidate. */
  refresh: boolean;
  reason: string;
}

/**
 * Decide whether a golden baseline may be refreshed. Refresh is regression-
 * by-default: a schema/status change is NEVER auto-applied. The caller must
 * pass `explicitRefresh: true` (e.g. a `--refresh` CLI flag) to update the
 * stored baseline; otherwise a diff is reported as a regression and the
 * existing golden is left untouched.
 */
export function decideRefresh(
  compareResult: CompareResult,
  explicitRefresh: boolean
): RefreshDecision {
  if (compareResult.pass) {
    return { refresh: false, reason: "no diff — baseline already matches" };
  }
  if (!explicitRefresh) {
    return {
      refresh: false,
      reason: "diff detected — flagged as regression; re-run with explicit refresh to update baseline",
    };
  }
  return { refresh: true, reason: "explicit refresh requested — baseline updated" };
}

export interface DriftFlag {
  drifted: boolean;
  goldenVersion: string | null;
  currentVersion: string;
}

/**
 * Flag a golden whose `oas_version` no longer matches the current spec's
 * version (drift hook, plan acceptance bullet 7). Observed-only goldens
 * (`oas_version: null`) never drift — they have no spec provenance to compare.
 */
export function checkOasDrift(golden: GoldenResponse, currentOasVersion: string): DriftFlag {
  if (golden.oas_version === null) {
    return { drifted: false, goldenVersion: null, currentVersion: currentOasVersion };
  }
  return {
    drifted: golden.oas_version !== currentOasVersion,
    goldenVersion: golden.oas_version,
    currentVersion: currentOasVersion,
  };
}
