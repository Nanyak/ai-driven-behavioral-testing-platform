/**
 * Within-run dedup + prefix clustering + per-persona cap (plan section Dedup /
 * clustering, ADR 0002). This is a WITHIN-RUN collapse only; cross-run "already
 * has a test" filtering is the separate skip gate in coverage.ts.
 *
 * Steps:
 *   1. Collapse flows with IDENTICAL canonical signatures -> keep highest support.
 *   2. Cluster flows sharing a common prefix of >= 3 tokens -> keep the longest
 *      representative (the subsumed shorter prefix is dropped).
 *   3. Cap output at 10 canonical flows per persona.
 *
 * All "same flow?" comparisons go through signature.ts (the single source,
 * ADR 0002).
 */

import { canonicalTokens, flowSignature } from "./signature.js";
import type { FlowAttributes } from "./attributes.js";
import type { Persona } from "./persona.js";

/** A step in a mined flow, with the modal expected status from supporting logs. */
export interface CandidateStep {
  method: string;
  endpoint: string;
  expected_status: number;
}

/** A mined, classified flow before ranking/naming. */
export interface MinedFlow {
  signature: string;
  /** Canonical `METHOD endpoint` tokens (consecutive dups already collapsed). */
  tokens: string[];
  steps: CandidateStep[];
  support: number;
  persona: Persona;
  attributes: FlowAttributes;
  /** Supporting session ids (validation/provenance only, capped when emitted). */
  source_sessions: string[];
}

export const PER_PERSONA_CAP = 10;

/** 1. Collapse identical-signature flows, keeping the highest-support one. */
function collapseIdentical(flows: MinedFlow[]): MinedFlow[] {
  const bySig = new Map<string, MinedFlow>();
  for (const flow of flows) {
    const existing = bySig.get(flow.signature);
    if (!existing || flow.support > existing.support) {
      bySig.set(flow.signature, flow);
    }
  }
  return [...bySig.values()];
}

/** True when `shorter`'s tokens are a prefix (length >= 3) of `longer`'s tokens. */
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

/**
 * 2. Cluster flows sharing a >=3-token common prefix: drop a flow that is a
 * proper prefix of a longer kept flow (keep the longest representative). Done
 * per persona so a guest prefix never absorbs a customer journey.
 */
function clusterByPrefix(flows: MinedFlow[]): MinedFlow[] {
  // Longest first so a representative is seen before its prefixes.
  const ordered = [...flows].sort(
    (a, b) => b.tokens.length - a.tokens.length || b.support - a.support
  );
  const kept: MinedFlow[] = [];
  for (const flow of ordered) {
    const subsumed = kept.some(
      (rep) => rep.persona === flow.persona && isPrefixOf(flow.tokens, rep.tokens)
    );
    if (!subsumed) {
      kept.push(flow);
    }
  }
  return kept;
}

/**
 * 3. Cap at PER_PERSONA_CAP per persona, keeping the highest-support flows.
 * Caller is expected to have ranked; we sort by support as a stable fallback so
 * the cap is deterministic even on unranked input.
 */
function capPerPersona(flows: MinedFlow[]): MinedFlow[] {
  const counts = new Map<Persona, number>();
  const kept: MinedFlow[] = [];
  const ordered = [...flows].sort(
    (a, b) => b.support - a.support || b.tokens.length - a.tokens.length
  );
  for (const flow of ordered) {
    const n = counts.get(flow.persona) ?? 0;
    if (n >= PER_PERSONA_CAP) {
      continue;
    }
    counts.set(flow.persona, n + 1);
    kept.push(flow);
  }
  return kept;
}

export interface DedupResult {
  flows: MinedFlow[];
  collapsedIdentical: number;
  clusteredPrefix: number;
  cappedOut: number;
}

/** Full within-run dedup pipeline. Steps 1->2->3 in order. */
export function dedup(flows: MinedFlow[]): DedupResult {
  const afterIdentical = collapseIdentical(flows);
  const afterPrefix = clusterByPrefix(afterIdentical);
  const afterCap = capPerPersona(afterPrefix);
  return {
    flows: afterCap,
    collapsedIdentical: flows.length - afterIdentical.length,
    clusteredPrefix: afterIdentical.length - afterPrefix.length,
    cappedOut: afterPrefix.length - afterCap.length,
  };
}

/** Re-export so callers build signatures/tokens through the single source. */
export { canonicalTokens, flowSignature };
