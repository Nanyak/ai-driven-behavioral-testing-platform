/**
 * First-order Markov transition model (plan section Mining 3).
 *
 * Builds P(next | current) over the canonical token stream across all sessions.
 * A SUPPORTING signal only -- used to flag low-probability transitions as
 * anomaly hints (fed to naming.ts as context), never as a primary flow
 * generator and never as a classifier input.
 */

export interface Transition {
  from: string;
  to: string;
  count: number;
  probability: number;
}

export interface MarkovModel {
  /** from-token -> (to-token -> count). */
  counts: Map<string, Map<string, number>>;
  /** from-token -> total outgoing transitions (row sum). */
  totals: Map<string, number>;
}

export function buildMarkov(sessionTokenLists: string[][]): MarkovModel {
  const counts = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();

  for (const tokens of sessionTokenLists) {
    for (let i = 0; i + 1 < tokens.length; i++) {
      const from = tokens[i];
      const to = tokens[i + 1];
      let row = counts.get(from);
      if (!row) {
        row = new Map<string, number>();
        counts.set(from, row);
      }
      row.set(to, (row.get(to) ?? 0) + 1);
      totals.set(from, (totals.get(from) ?? 0) + 1);
    }
  }

  return { counts, totals };
}

/** P(to | from), or 0 if `from` was never observed as a source. */
export function transitionProbability(model: MarkovModel, from: string, to: string): number {
  const total = model.totals.get(from);
  if (!total) {
    return 0;
  }
  const count = model.counts.get(from)?.get(to) ?? 0;
  return count / total;
}

/**
 * Rare transitions in a token sequence: adjacent pairs whose probability is
 * below `threshold`. Used as anomaly hints for naming.ts (judgment context),
 * not as a hard gate.
 */
export function rareTransitions(
  model: MarkovModel,
  tokens: string[],
  threshold = 0.02
): Transition[] {
  const out: Transition[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const from = tokens[i];
    const to = tokens[i + 1];
    const probability = transitionProbability(model, from, to);
    if (probability > 0 && probability < threshold) {
      out.push({
        from,
        to,
        count: model.counts.get(from)?.get(to) ?? 0,
        probability,
      });
    }
  }
  return out;
}
