/**
 * Assemble one EvidenceBundle per failure from the deterministic report
 * (attribution + golden-diff summary + statuses), enriched with:
 *   - response_body_excerpt (v2a) from the normalized run, matched per step;
 *   - required_missing (v2b) by intersecting the missing fields with the OAS
 *     required paths for the operation, when the augmented specs are available.
 * The OAS lookup is best-effort: no specs, or an unresolvable operation, simply
 * leaves required_missing empty ("unknown", never "nothing required").
 */
import type { OasDocument } from "../../../golden/src/oas-types.js";
import { requiredResponsePaths } from "../../../golden/src/oas/required-paths.js";
import type { NormalizedRunResult } from "../collect.js";
import type { FailureEntry, Report } from "../report/schema.js";
import { computeFailureId } from "./id.js";
import type { EvidenceBundle } from "./types.js";

export type AugmentedSpecs = Record<"store" | "admin", OasDocument>;

function bodyKey(persona: string, flowId: string, endpoint: string): string {
  return `${persona}|${flowId}|${endpoint}`;
}

/** Map a failing step's (persona, flow, endpoint) -> its captured response body. */
function responseBodyIndex(normalized: NormalizedRunResult | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!normalized) return out;
  for (const test of normalized.tests) {
    const flowId = test.flow_signature ?? test.flow_name;
    for (const step of test.steps) {
      if (step.status !== "failed" || step.response_body == null) continue;
      out.set(bodyKey(test.persona, flowId, step.endpoint), step.response_body);
    }
  }
  return out;
}

function splitEndpoint(endpoint: string): { method: string; path: string } {
  const space = endpoint.indexOf(" ");
  if (space === -1) return { method: "", path: endpoint };
  return { method: endpoint.slice(0, space), path: endpoint.slice(space + 1) };
}

function requiredMissing(entry: FailureEntry, specs: AugmentedSpecs | null): string[] {
  const missing = entry.golden_diff?.missing;
  if (!specs || !missing || missing.length === 0) return [];
  // On a schema diff the status matched, so expected_status is the response status.
  const status = entry.expected_status ?? entry.actual_status;
  if (status == null) return [];
  const { method, path } = splitEndpoint(entry.endpoint);
  if (!method) return [];
  const required = requiredResponsePaths(specs, method, path, status);
  if (!required) return [];
  return missing.filter((p) => required.has(p));
}

export function buildEvidence(
  report: Report,
  normalized: NormalizedRunResult | null,
  specs: AugmentedSpecs | null,
): EvidenceBundle[] {
  const bodies = responseBodyIndex(normalized);

  return report.failures.map((entry) => {
    const flowId = entry.flow_signature ?? entry.flow_name;
    const { method } = splitEndpoint(entry.endpoint);
    return {
      failure_id: computeFailureId(entry),
      persona: entry.persona,
      flow_name: entry.flow_name,
      flow_signature: entry.flow_signature,
      endpoint: entry.endpoint,
      method,
      expected_status: entry.expected_status,
      actual_status: entry.actual_status,
      golden_diff: entry.golden_diff,
      required_missing: requiredMissing(entry, specs),
      failure_message: entry.failure_message,
      response_body_excerpt: bodies.get(bodyKey(entry.persona, flowId, entry.endpoint)) ?? null,
      source_sessions: entry.source_sessions,
    };
  });
}
