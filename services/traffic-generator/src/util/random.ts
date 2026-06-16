/**
 * Generic randomness primitives — the single source of truth for the generator.
 * Previously these were copy-pasted across actions.ts, sampling.ts, noise.ts and
 * state.ts; everything now imports from here.
 */

/** A uniformly random element, or undefined for an empty list. */
export function pick<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/** True with the given probability (0..1). */
export function chance(probability: number): boolean {
  return Math.random() < probability;
}

/** Fisher–Yates shuffle in place; returns the same array for chaining. */
export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
