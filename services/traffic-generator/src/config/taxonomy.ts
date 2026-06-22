import type { Weights } from "./config.js";

/** One leaf of the situation taxonomy (plan §4). Mirrors the Weights keys. */
export type SessionType = keyof Weights;

export const SESSION_TYPES: SessionType[] = [
  "bounce",
  "browse",
  "cartAbandon",
  "checkoutAbandon",
  "returningCheckout",
  "newCheckout",
  "directLanding",
  "comparisonBrowse",
  "categoryBrowse",
  "multiItemCheckout",
  "cartWallConversion",
  "stockOutCheckout",
  "cartReviseAbandon",
  "orderStatus",
  "repeatOrderCheck",
  "profileMgmt",
  "returns",
  "adminCatalog",
  "adminFulfill",
  "adminRefund",
  "adminReturnReject",
  "adminCancel",
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
  returningCheckout: 1,
  newCheckout: 1,
  directLanding: 1,
  comparisonBrowse: 1,
  categoryBrowse: 1,
  multiItemCheckout: 1,
  cartWallConversion: 1,
  stockOutCheckout: 1,
  cartReviseAbandon: 1,
  profileMgmt: 1,
  adminCatalog: 1,
  edge: 1,
  // Stage 2 — needs prior orders/accounts.
  orderStatus: 2,
  repeatOrderCheck: 2,
  returns: 2,
  adminFulfill: 2,
  adminRefund: 2,
  adminReturnReject: 2,
  adminCancel: 2,
  adminSupport: 2,
};

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
 * Per-type identity split for the leaves where identity isn't fixed by type (plan §4).
 * Cart-bearing leaves (cartAbandon, checkoutAbandon, multiItemCheckout) are always
 * returning — the storefront requires auth to add to cart. directLanding guest identity
 * applies only to bounce/browse intents; cart intents force auth in dispatch.
 */
const IDENTITY_SPLIT: Partial<Record<SessionType, Partial<Record<Identity, number>>>> = {
  bounce: { guest: 90, returning: 10 },
  browse: { guest: 90, returning: 10 },
  cartAbandon: { returning: 100 },
  checkoutAbandon: { returning: 100 },
  directLanding: { guest: 70, returning: 30 },
  comparisonBrowse: { guest: 80, returning: 20 },
  categoryBrowse: { guest: 80, returning: 20 },
  multiItemCheckout: { returning: 100 },
};

/** Resolve the identity to drive a session of the given type. */
export function identityFor(type: SessionType): Identity {
  const split = IDENTITY_SPLIT[type];
  if (split) return splitIdentity(split);
  switch (type) {
    case "returningCheckout":
    case "cartWallConversion": // guest hits the wall, then logs into a pooled account
    case "stockOutCheckout": // returning customer hits the insufficient-inventory 400
    case "cartReviseAbandon": // returning customer curates a cart, then abandons
    case "orderStatus":
    case "repeatOrderCheck":
    case "profileMgmt":
    case "returns":
      return "returning";
    case "newCheckout":
      return "new";
    default:
      return "guest"; // admin / edge — identity is not a meaningful axis.
  }
}
