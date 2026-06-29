// Candidates are already deduped within-run by behavior-engine's dedup.ts, but
// this module re-applies the same rules defensively since it is a separate
// process boundary reading a JSON artifact, not a guarantee enforced by a type
// system. Reuses the SAME canonical flow signature (ADR 0002) via
// behavior-engine's `signature.ts` — this module defines no second "same
// flow?" key.
import { selectBusinessScenarios } from "../../behavior-engine/src/selection/scenarios.js";
import type { Candidate } from "./load.js";

function collapseIdentical(candidates: Candidate[]): Candidate[] {
  const bySig = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = bySig.get(candidate.signature);
    if (!existing || candidate.support > existing.support) {
      bySig.set(candidate.signature, candidate);
    }
  }
  return [...bySig.values()];
}

export interface DedupResult {
  candidates: Candidate[];
  collapsedIdentical: number;
  clusteredPrefix: number;
  cappedOut: number;
}

export function dedup(
  candidates: Candidate[],
  approvedSignatures: ReadonlySet<string> = new Set()
): DedupResult {
  const afterIdentical = collapseIdentical(candidates);
  const scenarios = selectBusinessScenarios(afterIdentical, approvedSignatures);
  const afterScenarios = scenarios.representatives.map(({ candidate, scenario_name }) => ({
    ...candidate,
    // Review and generated source use the same stable business-scenario label.
    flow_name: scenario_name,
  }));
  return {
    candidates: afterScenarios,
    collapsedIdentical: candidates.length - afterIdentical.length,
    clusteredPrefix: scenarios.collapsed,
    cappedOut: 0,
  };
}
