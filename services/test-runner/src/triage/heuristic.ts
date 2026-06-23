/**
 * Deterministic offline verdict. This is the FALLBACK FLOOR: it runs when no
 * ANTHROPIC_API_KEY is present, and whenever an LLM call fails or returns
 * unusable output — so `npm run triage` always produces a complete triage.json,
 * offline and in CI, with no key. The LLM (llm.ts) only ever sharpens these.
 */
import type { Confidence, EvidenceBundle, Verdict } from "./types.js";

export interface HeuristicVerdict {
  verdict: Verdict;
  confidence: Confidence;
  rationale: string;
  recommended_action: string;
}

const TEST_ARTIFACT_RE = /\b(register|login|extractPath|resolve|setup|ECONNREFUSED|timeout|timed out)\b/i;

function is2xx(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

export function heuristicVerdict(e: EvidenceBundle): HeuristicVerdict {
  // 1. Failed before any request, or a setup/resolver/login error -> the spec,
  //    not the SUT.
  if (e.endpoint === "(no request step)" || (e.failure_message && TEST_ARTIFACT_RE.test(e.failure_message))) {
    return {
      verdict: "test_artifact",
      confidence: "medium",
      rationale: "Failure originates in setup/resolution (auth, captured-id, or a non-request error), not the response contract.",
      recommended_action: "Inspect the generated spec / script-generator resolver; re-run before filing a SUT bug.",
    };
  }

  // 2. Status mismatch dominates the shape diff (compare.ts returns an empty
  //    schemaDiff on a status mismatch, so judge on status alone here).
  if (is2xx(e.expected_status) && e.actual_status !== null && !is2xx(e.actual_status)) {
    if (e.actual_status >= 500) {
      return {
        verdict: "real_regression",
        confidence: "high",
        rationale: `Stable endpoint expected ${e.expected_status} but returned ${e.actual_status} — a server-side fault, not a contract change.`,
        recommended_action: "File a SUT bug for the 5xx on this endpoint; check recent backend changes to the handler.",
      };
    }
    if (e.actual_status === 401 || e.actual_status === 403) {
      return {
        verdict: "test_artifact",
        confidence: "medium",
        rationale: `Got ${e.actual_status} where ${e.expected_status} was expected — most often a missing/ineligible auth token in the generated flow, not a SUT regression.`,
        recommended_action: "Verify the flow's auth setup (gate eligibility) before treating as a regression.",
      };
    }
    return {
      verdict: "real_regression",
      confidence: "medium",
      rationale: `Endpoint expected ${e.expected_status} but returned ${e.actual_status}.`,
      recommended_action: "Confirm whether the new status is an intended API change (then update the golden) or a regression.",
    };
  }

  // 3. Status matched; judge on the schema diff.
  if (e.golden_diff) {
    const { missing, unexpected, type_changed } = e.golden_diff;
    if (e.required_missing.length > 0) {
      return {
        verdict: "real_regression",
        confidence: "high",
        rationale: `Required response field(s) absent: ${e.required_missing.join(", ")}. The OpenAPI contract marks these mandatory.`,
        recommended_action: "File a SUT bug — a required field disappeared from the response.",
      };
    }
    if (missing.length === 0 && type_changed.length === 0 && unexpected.length > 0) {
      return {
        verdict: "contract_drift",
        confidence: "medium",
        rationale: `Only additive change: new field(s) ${unexpected.join(", ")} not in the golden. Usually an intentional, backward-compatible API addition.`,
        recommended_action: "Review, then refresh the golden schema for this endpoint to absorb the new field(s).",
      };
    }
    if (type_changed.length > 0) {
      return {
        verdict: "real_regression",
        confidence: "medium",
        rationale: `Field type(s) changed: ${type_changed.join(", ")} — a breaking shape change on a matched status.`,
        recommended_action: "Determine if the type change was intended (update golden) or a regression (file bug).",
      };
    }
    return {
      verdict: "uncertain",
      confidence: "medium",
      rationale: `Optional field(s) missing: ${missing.join(", ")}. Could be a benign conditional field or a regression.`,
      recommended_action: "Human review: confirm whether the missing field is conditionally present.",
    };
  }

  return {
    verdict: "uncertain",
    confidence: "low",
    rationale: "Insufficient structured evidence to classify automatically.",
    recommended_action: "Review the Playwright HTML report for this failure.",
  };
}
