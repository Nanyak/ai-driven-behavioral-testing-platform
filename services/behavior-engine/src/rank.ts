/**
 * Candidate ranking (plan section Ranking).
 *
 * Score = weighted sum of normalized signals. ALL weights live in ONE config
 * object with explicit defaults (PO-5/7) so ranking is tunable and explainable.
 *
 * Signals:
 *   - support           : session support, log-scaled then normalized to [0,1].
 *   - personaCoverage    : rewards covering a persona that few other candidates
 *                          cover (breadth across guest/customer/admin).
 *   - endpointImportance : checkout/auth/admin endpoints weigh higher than pure
 *                          browsing. BUSINESS IMPORTANCE IS MERGED HERE
 *                          (PO-7): "business importance" and "endpoint
 *                          importance" were two names for the same idea --
 *                          revenue/identity/state-changing endpoints matter more
 *                          than reads -- so they are one signal, stated here
 *                          rather than double-counted.
 *   - errorCoverage      : rewards has_errors flows so negative behavior is not
 *                          out-competed by high-volume happy paths.
 *
 * Tie-break after scoring is deterministic (PO-5): score desc, then support desc,
 * then pattern length desc, then lexicographic signature.
 */

import type { MinedFlow } from "./dedup.js";
import type { Persona } from "./persona.js";

export interface RankWeights {
  support: number;
  personaCoverage: number;
  endpointImportance: number;
  errorCoverage: number;
}

/** Per-endpoint importance multipliers (the merged business+endpoint signal). */
export interface EndpointImportance {
  patterns: Array<{ match: string; weight: number }>;
  /** Default weight for endpoints matching nothing above (browsing reads). */
  baseline: number;
}

export interface RankConfig {
  weights: RankWeights;
  endpointImportance: EndpointImportance;
}

export const DEFAULT_RANK_CONFIG: RankConfig = {
  weights: {
    support: 0.4,
    personaCoverage: 0.15,
    endpointImportance: 0.3,
    errorCoverage: 0.15,
  },
  endpointImportance: {
    patterns: [
      { match: "/store/carts/{id}/complete", weight: 1.0 },
      { match: "/admin/returns", weight: 0.95 },
      { match: "/admin/orders", weight: 0.9 },
      { match: "/auth/customer", weight: 0.85 },
      { match: "/store/customers", weight: 0.85 },
      { match: "/store/payment-collections", weight: 0.8 },
      { match: "/store/carts", weight: 0.7 },
      { match: "/admin/", weight: 0.7 },
    ],
    baseline: 0.2,
  },
};

function endpointWeight(token: string, importance: EndpointImportance): number {
  for (const { match, weight } of importance.patterns) {
    if (token.includes(match)) {
      return weight;
    }
  }
  return importance.baseline;
}

export interface ScoredFlow extends MinedFlow {
  score: number;
  /** Component breakdown, for explainability in the run summary. */
  score_parts: {
    support: number;
    personaCoverage: number;
    endpointImportance: number;
    errorCoverage: number;
  };
}

/**
 * Score and sort flows. `personaCounts` is the per-persona candidate count over
 * the input set (used to reward breadth: a persona with fewer candidates scores
 * higher on coverage).
 */
export function rankFlows(
  flows: MinedFlow[],
  config: RankConfig = DEFAULT_RANK_CONFIG
): ScoredFlow[] {
  if (flows.length === 0) {
    return [];
  }

  const maxLogSupport = Math.max(
    ...flows.map((f) => Math.log1p(f.support)),
    Math.log1p(1)
  );

  const personaCounts = new Map<Persona, number>();
  for (const flow of flows) {
    personaCounts.set(flow.persona, (personaCounts.get(flow.persona) ?? 0) + 1);
  }
  const maxPersonaCount = Math.max(...personaCounts.values());

  const scored = flows.map<ScoredFlow>((flow) => {
    const supportN = Math.log1p(flow.support) / maxLogSupport;

    // Rarer persona -> higher coverage reward (inverse of its share).
    const personaCount = personaCounts.get(flow.persona) ?? 1;
    const personaCoverageN = maxPersonaCount > 0 ? 1 - (personaCount - 1) / maxPersonaCount : 1;

    const endpointImportanceN = Math.max(
      ...flow.tokens.map((t) => endpointWeight(t, config.endpointImportance))
    );

    const errorCoverageN = flow.attributes.has_errors ? 1 : 0;

    const parts = {
      support: config.weights.support * supportN,
      personaCoverage: config.weights.personaCoverage * personaCoverageN,
      endpointImportance: config.weights.endpointImportance * endpointImportanceN,
      errorCoverage: config.weights.errorCoverage * errorCoverageN,
    };
    const score =
      parts.support + parts.personaCoverage + parts.endpointImportance + parts.errorCoverage;

    return { ...flow, score, score_parts: parts };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.support !== a.support) {
      return b.support - a.support;
    }
    if (b.tokens.length !== a.tokens.length) {
      return b.tokens.length - a.tokens.length;
    }
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
  });

  return scored;
}

export function priorityOf(flow: ScoredFlow): "high" | "medium" | "low" {
  if (flow.attributes.is_admin || flow.tokens.some((t) => t.includes("/complete"))) {
    return "high";
  }
  if (flow.attributes.requires_auth || flow.attributes.has_errors) {
    return "medium";
  }
  return "low";
}
