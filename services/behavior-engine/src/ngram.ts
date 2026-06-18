/**
 * N-gram baseline miner (plan section Mining 1).
 *
 * Slides fixed windows (n = 2,3,4) over each session's canonical token sequence
 * and counts how many DISTINCT sessions each window appears in (session support,
 * not raw occurrence -- the same unit PrefixSpan uses, so the comparison in the
 * run summary is apples-to-apples). Fast and explainable; its job is to be a
 * demo contrast against PrefixSpan, not the primary generator.
 *
 * Operates on the canonical token list (consecutive dups already collapsed by
 * signature.ts) so n-gram and PrefixSpan see the same normalized stream. Tokens
 * are joined on "\n" (a token "METHOD endpoint" can never contain a newline).
 */

const SEP = "\n";

export interface NGram {
  tokens: string[];
  support: number;
}

export const NGRAM_SIZES = [2, 3, 4] as const;

/** Count session-support for every n-gram of the given sizes. */
export function mineNGrams(
  sessionTokenLists: string[][],
  sizes: readonly number[] = NGRAM_SIZES,
  minSupport = 3
): NGram[] {
  // window-key -> set of session indices it appeared in.
  const support = new Map<string, Set<number>>();

  sessionTokenLists.forEach((tokens, sessionIdx) => {
    for (const n of sizes) {
      if (tokens.length < n) {
        continue;
      }
      // Dedup windows within a session so each session counts at most once.
      const seenThisSession = new Set<string>();
      for (let i = 0; i + n <= tokens.length; i++) {
        const key = tokens.slice(i, i + n).join(SEP);
        if (seenThisSession.has(key)) {
          continue;
        }
        seenThisSession.add(key);
        let set = support.get(key);
        if (!set) {
          set = new Set<number>();
          support.set(key, set);
        }
        set.add(sessionIdx);
      }
    }
  });

  const result: NGram[] = [];
  for (const [key, sessions] of support) {
    if (sessions.size >= minSupport) {
      result.push({ tokens: key.split(SEP), support: sessions.size });
    }
  }
  result.sort((a, b) => b.support - a.support || b.tokens.length - a.tokens.length);
  return result;
}
