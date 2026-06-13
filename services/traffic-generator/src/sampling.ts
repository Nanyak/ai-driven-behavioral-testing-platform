import type { Weights } from "./config.js";

/** One leaf of the situation taxonomy (plan §4). Mirrors the Weights keys. */
export type SessionType = keyof Weights;

export const SESSION_TYPES: SessionType[] = [
  "bounce",
  "browse",
  "cartAbandon",
  "checkoutAbandon",
  "guestCheckout",
  "returningCheckout",
  "newCheckout",
  "orderStatus",
  "profileMgmt",
  "returns",
  "adminCatalog",
  "adminFulfill",
  "adminRefund",
  "adminSupport",
  "edge",
];

export type Identity = "guest" | "returning" | "new";

/** Which stage a session type runs in (plan §5). */
export const STAGE_OF: Record<SessionType, 1 | 2> = {
  bounce: 1,
  browse: 1,
  cartAbandon: 1,
  checkoutAbandon: 1,
  guestCheckout: 1,
  returningCheckout: 1,
  newCheckout: 1,
  profileMgmt: 1,
  adminCatalog: 1,
  edge: 1, // G — self-contained error cases, no prior state needed.
  // Stage 2 — needs prior orders/accounts.
  orderStatus: 2,
  returns: 2,
  adminFulfill: 2,
  adminRefund: 2,
  adminSupport: 2,
};

export function chance(probability: number): boolean {
  return Math.random() < probability;
}

export function pick<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Allocate `total` sessions across the taxonomy proportional to weights, using
 * the largest-remainder method so rounding never loses/gains a session.
 */
export function weightedAllocation(weights: Weights, total: number): Record<SessionType, number> {
  const sum = SESSION_TYPES.reduce((s, t) => s + Math.max(0, weights[t]), 0) || 1;
  const exact = SESSION_TYPES.map((t) => ({ type: t, raw: (Math.max(0, weights[t]) / sum) * total }));
  const counts = {} as Record<SessionType, number>;
  let assigned = 0;
  for (const e of exact) {
    counts[e.type] = Math.floor(e.raw);
    assigned += counts[e.type];
  }
  // Distribute the remainder to the largest fractional parts.
  const remainder = total - assigned;
  exact
    .map((e) => ({ type: e.type, frac: e.raw - Math.floor(e.raw) }))
    .sort((a, b) => b.frac - a.frac)
    .slice(0, Math.max(0, remainder))
    .forEach((e) => (counts[e.type] += 1));
  return counts;
}

/**
 * Pick an identity from a weighted split, e.g. { guest: 50, returning: 38, new: 12 }.
 * Missing identities are treated as weight 0.
 */
export function splitIdentity(split: Partial<Record<Identity, number>>): Identity {
  const entries = (Object.entries(split) as [Identity, number][]).filter(([, w]) => w > 0);
  const sum = entries.reduce((s, [, w]) => s + w, 0) || 1;
  let r = Math.random() * sum;
  for (const [id, w] of entries) {
    r -= w;
    if (r <= 0) return id;
  }
  return entries[0]?.[0] ?? "guest";
}

/**
 * Geometric-ish count with the given mean, clamped to [1, cap]. Used for
 * "products viewed per session" and similar (plan §4.1).
 */
export function geometricCount(mean: number, cap: number): number {
  const p = 1 / Math.max(1, mean);
  let n = 1;
  while (n < cap && Math.random() > p) n++;
  return n;
}

export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
