/**
 * Within-run dedup + prefix clustering + per-persona cap (plan section Dedup /
 * clustering, ADR 0002). This is a WITHIN-RUN collapse only; cross-run "already
 * has a test" filtering is the separate skip gate in coverage.ts.
 *
 * Steps:
 *   1. Collapse flows with IDENTICAL canonical signatures -> keep highest support.
 *   2. Prune SUBSUMED flows: drop a flow whose token sequence is a contiguous
 *      sub-run (>= 2 tokens) of a longer kept flow of the same persona -> keep the
 *      longest representative. This is the checklist's "prune duplicate or subsumed
 *      flows" (a prefix is just the start-anchored case); it collapses the many
 *      mid-journey fragments (e.g. `shipping-options -> payment-collections`) into
 *      the full journey that contains them, so the canonical journey is not crowded
 *      out of the cap by its own high-support sub-fragments.
 *   3. Cap output at 10 canonical flows per persona -- applied by the CALLER AFTER
 *      ranking (capRankedPerPersona), so the cap keeps the highest-VALUE flows
 *      (ranking weights order placement / auth / admin), not the highest-volume
 *      short fragments.
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

/**
 * True when `shorter`'s tokens appear as a contiguous sub-run (length >= 2) of
 * `longer`'s tokens. A prefix is the start-anchored special case; this also
 * catches mid-journey fragments (e.g. a checkout's `shipping-options ->
 * payment-collections` middle inside the full `cart -> ... -> complete` chain).
 */
function isContiguousSubsequenceOf(shorter: string[], longer: string[]): boolean {
  if (shorter.length < 2 || shorter.length >= longer.length) {
    return false;
  }
  for (let start = 0; start + shorter.length <= longer.length; start++) {
    let match = true;
    for (let i = 0; i < shorter.length; i++) {
      if (longer[start + i] !== shorter[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return true;
    }
  }
  return false;
}

/**
 * 2. Prune subsumed flows: drop a flow that is a contiguous sub-run of a longer
 * kept flow (keep the longest representative). Done per persona so a guest
 * fragment never absorbs (or is absorbed into) a customer journey.
 */
function pruneSubsumed(flows: MinedFlow[]): MinedFlow[] {
  // Longest first so a representative is seen before its sub-runs.
  const ordered = [...flows].sort(
    (a, b) => b.tokens.length - a.tokens.length || b.support - a.support
  );
  const kept: MinedFlow[] = [];
  for (const flow of ordered) {
    const subsumed = kept.some(
      (rep) => rep.persona === flow.persona && isContiguousSubsequenceOf(flow.tokens, rep.tokens)
    );
    if (!subsumed) {
      kept.push(flow);
    }
  }
  return kept;
}

/**
 * 3. Cap at PER_PERSONA_CAP per persona, preserving rank order. Apply this AFTER
 * ranking (rankFlows returns score-sorted), so the cap keeps the highest-VALUE
 * flows per persona — order placement / auth / admin rank above browsing reads —
 * not whichever short fragments happen to have the most volume.
 *
 * BALANCED across the has_errors split: the script generator routes clean flows
 * to their persona folder and has_errors flows to `edge/`. Error flows score
 * higher (errorCoverage + cart/auth endpoints), so a persona's top-`cap` can be
 * ALL errors — leaving that persona's own test folder empty. So reserve up to
 * half the cap for each class (clean / error) when both exist, then fill the
 * rest by rank. Per-persona total stays <= cap. Generic over the flow type.
 */
export function capRankedPerPersona<T extends MinedFlow>(
  rankedFlows: T[],
  cap: number = PER_PERSONA_CAP
): { kept: T[]; cappedOut: number } {
  const byPersona = new Map<Persona, T[]>();
  for (const flow of rankedFlows) {
    const list = byPersona.get(flow.persona);
    if (list) list.push(flow);
    else byPersona.set(flow.persona, [flow]);
  }

  const kept: T[] = [];
  const reserve = Math.floor(cap / 2);
  for (const flows of byPersona.values()) {
    const clean = flows.filter((f) => !f.attributes.has_errors);
    const errors = flows.filter((f) => f.attributes.has_errors);
    const keepSet = new Set<T>();
    for (const f of clean.slice(0, reserve)) keepSet.add(f);
    for (const f of errors.slice(0, reserve)) keepSet.add(f);
    for (const f of flows) {
      if (keepSet.size >= cap) break;
      keepSet.add(f);
    }
    // Emit in rank order, hard-capped at `cap`.
    kept.push(...flows.filter((f) => keepSet.has(f)).slice(0, cap));
  }
  return { kept, cappedOut: rankedFlows.length - kept.length };
}

export interface DedupResult {
  flows: MinedFlow[];
  collapsedIdentical: number;
  subsumed: number;
}

/**
 * Within-run dedup: collapse identical, then prune subsumed (steps 1->2). The
 * per-persona cap is step 3 and is applied by the caller AFTER ranking via
 * capRankedPerPersona, so ranking — not raw support — decides what survives.
 */
export function dedup(flows: MinedFlow[]): DedupResult {
  const afterIdentical = collapseIdentical(flows);
  const afterSubsumed = pruneSubsumed(afterIdentical);
  return {
    flows: afterSubsumed,
    collapsedIdentical: flows.length - afterIdentical.length,
    subsumed: afterIdentical.length - afterSubsumed.length,
  };
}

/** Re-export so callers build signatures/tokens through the single source. */
export { canonicalTokens, flowSignature };
