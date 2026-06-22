// Candidates are already deduped within-run by behavior-engine's dedup.ts, but
// this module re-applies the same rules defensively since it is a separate
// process boundary reading a JSON artifact, not a guarantee enforced by a type
// system. Reuses the SAME canonical flow signature (ADR 0002) via
// behavior-engine's `signature.ts` — this module defines no second "same
// flow?" key.
import { canonicalTokens, type SignatureStep } from "../../behavior-engine/src/signature.js";
import type { Candidate } from "./load.js";

export const PER_PERSONA_CAP = 10;

function tokensOf(candidate: Candidate): string[] {
  return canonicalTokens(candidate.steps as SignatureStep[]);
}

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

function isPrefixOf(shorter: string[], longer: string[]): boolean {
  if (shorter.length < 3 || shorter.length >= longer.length) {
    return false;
  }
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) {
      return false;
    }
  }
  return true;
}

function clusterByPrefix(candidates: Candidate[]): Candidate[] {
  const withTokens = candidates.map((c) => ({ candidate: c, tokens: tokensOf(c) }));
  const ordered = [...withTokens].sort(
    (a, b) => b.tokens.length - a.tokens.length || b.candidate.support - a.candidate.support
  );
  const kept: typeof ordered = [];
  for (const entry of ordered) {
    const subsumed = kept.some(
      (rep) =>
        rep.candidate.persona === entry.candidate.persona && isPrefixOf(entry.tokens, rep.tokens)
    );
    if (!subsumed) {
      kept.push(entry);
    }
  }
  return kept.map((e) => e.candidate);
}

function capPerPersona(candidates: Candidate[]): Candidate[] {
  const counts = new Map<string, number>();
  const kept: Candidate[] = [];
  const ordered = [...candidates].sort(
    (a, b) => b.support - a.support || b.steps.length - a.steps.length
  );
  for (const candidate of ordered) {
    const n = counts.get(candidate.persona) ?? 0;
    if (n >= PER_PERSONA_CAP) {
      continue;
    }
    counts.set(candidate.persona, n + 1);
    kept.push(candidate);
  }
  return kept;
}

export interface DedupResult {
  candidates: Candidate[];
  collapsedIdentical: number;
  clusteredPrefix: number;
  cappedOut: number;
}

export function dedup(candidates: Candidate[]): DedupResult {
  const afterIdentical = collapseIdentical(candidates);
  const afterPrefix = clusterByPrefix(afterIdentical);
  const afterCap = capPerPersona(afterPrefix);
  return {
    candidates: afterCap,
    collapsedIdentical: candidates.length - afterIdentical.length,
    clusteredPrefix: afterIdentical.length - afterPrefix.length,
    cappedOut: afterPrefix.length - afterCap.length,
  };
}
