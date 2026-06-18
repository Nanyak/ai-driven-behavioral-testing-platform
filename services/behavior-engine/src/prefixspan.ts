/**
 * PrefixSpan frequent sequential pattern mining (plan section Mining 2).
 *
 * Mines variable-length frequent SUBSEQUENCES (order-preserving, gaps allowed)
 * across sessions. Support is the number of distinct sessions a pattern is a
 * subsequence of. This is what recovers full journeys with optional intermediate
 * steps (e.g. the registered-customer checkout holdout, regardless of the
 * browsing noise around it).
 *
 * Support threshold is an ABSOLUTE FLOOR (minSupport = 3 sessions), never a
 * fraction of N (plan section "Support threshold: absolute floor, not
 * fractional") -- this is what lets thin edge-case (has_errors) behavior survive
 * into candidates.
 *
 * Determinism (PO-5): patterns are emitted in a pinned order --
 *   support desc, then pattern LENGTH desc, then lexicographic by token string.
 * The same input always yields the same ordered output.
 *
 * Implementation: tokens are interned to integers; each sequence is a list of
 * ints. We grow patterns one item at a time, tracking, per supporting sequence,
 * the earliest position from which the next item may be matched (a projected
 * database of pointers). maxPatternLength bounds journey length.
 */

export interface SequentialPattern {
  /** The pattern as interned token ids (decode with the returned vocabulary). */
  itemIds: number[];
  support: number;
}

export interface PrefixSpanResult {
  patterns: SequentialPattern[];
  /** id -> token, to decode `itemIds`. */
  vocabulary: string[];
}

export interface PrefixSpanOptions {
  minSupport?: number;
  maxPatternLength?: number;
  /**
   * Maximum gap (intervening steps) allowed between two matched items (default
   * 4). This is the PRINCIPLED bound on the combinatorial blow-up of gapped
   * subsequences: a real journey's steps occur close together (the checkout
   * backbone register->cart->line-items->complete is contiguous-ish even with
   * browsing noise interleaved), so an unbounded gap mostly manufactures
   * spurious long-distance "patterns". Bounding the gap collapses the pattern
   * space to genuine journeys and lets the full closed-pattern enumeration
   * complete in bounded memory while still recovering the holdout. A gap of 0
   * would be contiguous n-gram mining; we allow a few intervening steps.
   */
  maxGap?: number;
  /**
   * Per-starting-item budget (default 20,000). Each distinct first item is mined
   * under its own cap so a high-frequency root (browse) cannot starve a
   * low-volume but distinct one (admin reversals) — see "FAIRNESS PER ROOT".
   */
  perRootCap?: number;
  /**
   * Global safety cap on emitted patterns (default 400,000) — a backstop across
   * all roots in case a future traffic mix widens the space again.
   */
  maxPatterns?: number;
}

/** Intern tokens to integers; returns encoded sequences + the vocabulary. */
function intern(sessionTokenLists: string[][]): {
  sequences: number[][];
  vocabulary: string[];
} {
  const idOf = new Map<string, number>();
  const vocabulary: string[] = [];
  const sequences: number[][] = [];
  for (const tokens of sessionTokenLists) {
    const seq: number[] = [];
    for (const token of tokens) {
      let id = idOf.get(token);
      if (id === undefined) {
        id = vocabulary.length;
        idOf.set(token, id);
        vocabulary.push(token);
      }
      seq.push(id);
    }
    sequences.push(seq);
  }
  return { sequences, vocabulary };
}

/**
 * A projected entry: which sequence, and the index AFTER the last matched item
 * (the position from which the next item may be matched). One entry per
 * supporting sequence keeps support = distinct sequence count by construction.
 */
interface Projection {
  seqIdx: number;
  start: number;
}

export function minePrefixSpan(
  sessionTokenLists: string[][],
  options: PrefixSpanOptions = {}
): PrefixSpanResult {
  const minSupport = options.minSupport ?? 3;
  const maxPatternLength = options.maxPatternLength ?? 12;
  const maxGap = options.maxGap ?? 4;
  const maxPatterns = options.maxPatterns ?? 400_000;
  const { sequences, vocabulary } = intern(sessionTokenLists);

  const patterns: SequentialPattern[] = [];

  /**
   * Frequent forward extensions of a projected database, honouring `maxGap`:
   * the next item must appear within `maxGap` steps of the current start (an
   * unbounded scan is the gapped-subsequence explosion this avoids). The root
   * projection uses start = 0 with no gap bound (the pattern's first item may
   * occur anywhere in the session).
   */
  const extend = (
    projection: Projection[],
    bounded: boolean
  ): Array<{ item: number; proj: Projection[] }> => {
    const nextProjections = new Map<number, Projection[]>();
    for (const { seqIdx, start } of projection) {
      const seq = sequences[seqIdx];
      const limit = bounded ? Math.min(seq.length, start + maxGap + 1) : seq.length;
      const seenInThisSeq = new Set<number>();
      for (let i = start; i < limit; i++) {
        const item = seq[i];
        if (seenInThisSeq.has(item)) {
          continue; // first occurrence only, per supporting sequence.
        }
        seenInThisSeq.add(item);
        let list = nextProjections.get(item);
        if (!list) {
          list = [];
          nextProjections.set(item, list);
        }
        list.push({ seqIdx, start: i + 1 });
      }
    }
    const out: Array<{ item: number; proj: Projection[] }> = [];
    for (const [item, proj] of nextProjections) {
      if (proj.length >= minSupport) {
        out.push({ item, proj });
      }
    }
    return out;
  };

  // CLOSED sequential pattern mining. Mining ALL gapped subsequences is
  // combinatorial when many high-support tokens co-occur (every checkout shares
  // a long backbone). A pattern is CLOSED when no extension has the SAME support
  // (adding any item strictly lowers support); we emit only closed patterns,
  // which collapses the explosion of non-closed sub-patterns.
  //
  // FAIRNESS PER ROOT (the coverage fix): a single global budget lets the
  // highest-frequency root (GET /store/products) consume it before lower-volume
  // but distinct behavior (admin reversals) is ever reached, starving a whole
  // persona. So we mine each distinct STARTING item's projected database under
  // its own per-root budget. Every starting behavior — guest browse, customer
  // auth, admin ops — gets explored. Deterministic: roots and extensions are
  // both visited in ascending item id.
  const perRootCap = options.perRootCap ?? 20_000;

  const grow = (
    prefix: number[],
    projection: Projection[],
    rootStart: number
  ): void => {
    if (patterns.length >= maxPatterns || patterns.length - rootStart >= perRootCap) {
      return;
    }
    const extensions =
      prefix.length < maxPatternLength ? extend(projection, true) : [];
    const support = projection.length;

    const absorbed = extensions.some((e) => e.proj.length === support);
    if (!absorbed) {
      patterns.push({ itemIds: prefix, support });
    }

    extensions.sort((a, b) => a.item - b.item);
    for (const { item, proj } of extensions) {
      grow([...prefix, item], proj, rootStart);
      if (patterns.length >= maxPatterns || patterns.length - rootStart >= perRootCap) {
        return;
      }
    }
  };

  // Seed roots from the unbounded first-item scan (a pattern's first item may
  // occur anywhere in a session), then mine each root's projection fairly.
  const root: Projection[] = sequences.map((_, seqIdx) => ({ seqIdx, start: 0 }));
  const rootExtensions = extend(root, false).sort((a, b) => a.item - b.item);
  for (const { item, proj } of rootExtensions) {
    if (patterns.length >= maxPatterns) {
      break;
    }
    grow([item], proj, patterns.length);
  }

  // Deterministic global ordering (PO-5): support desc, length desc, then
  // lexicographic by decoded token string.
  patterns.sort((a, b) => {
    if (b.support !== a.support) {
      return b.support - a.support;
    }
    if (b.itemIds.length !== a.itemIds.length) {
      return b.itemIds.length - a.itemIds.length;
    }
    const sa = a.itemIds.map((id) => vocabulary[id]).join("\n");
    const sb = b.itemIds.map((id) => vocabulary[id]).join("\n");
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  return { patterns, vocabulary };
}

/** Decode a pattern's interned ids back to `METHOD endpoint` tokens. */
export function decodePattern(pattern: SequentialPattern, vocabulary: string[]): string[] {
  return pattern.itemIds.map((id) => vocabulary[id]);
}
