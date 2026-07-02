/**
 * Business-rules table (Phase B).
 *
 * A single declarative source for the PLAN-time preconditions the generator used
 * to re-derive by hand, scattered across `resolve.ts`. Each rule has TWO columns:
 *
 *   1. preconditions — what must be TRUE for a step to succeed, expressed as
 *      entity@state keys (`SkillKey`). Some are auth-context requirements
 *      (a logged-in customer / admin token); one references the checkout-ready
 *      chain (the shipping-method + payment-session prep that
 *      `appendCheckoutReadyResolvers` arranges out of the registry skills
 *      `shippingOption@any`, `paymentCollection@any`, `paymentProvider@any`).
 *      Where a plain id must be arranged, that stays the job of the skill
 *      registry (`resolveSkillForVar`), not this table.
 *
 *   2. expected rejection — what the backend returns when a precondition is
 *      UNMET: `{ status, bodyMatcher }`. For the customer-auth gate this is
 *      DERIVED from the backend's own `gate-contract.ts` (the single source of
 *      truth the server enforces and `build-oas.ts` documents) — so this module
 *      is a THIRD reader of those constants. Nothing here hardcodes `401` or the
 *      unauthorized envelope.
 *
 * Failure-path MINTING is deferred: this table describes the rejection side, but
 * the generator does NOT yet auto-mint brand-new negative test candidates from
 * it. `mirrorFailureCandidatesFor` is the seam for that future work (phase-C);
 * today it returns `[]`.
 */
import {
  GATE_MATCHERS,
  GATE_METHODS,
  GATE_UNAUTHORIZED_STATUS,
  GATE_UNAUTHORIZED_BODY,
} from "../../../../apps/medusa/apps/backend/src/api/gate-contract.js";
import type { AuthRequirement, SkillKey } from "../skill/registry.js";

export type { SkillKey };

/**
 * A precondition is an entity@state identity (`SkillKey`-shaped). Three of them
 * are auth/prep contexts the generator arranges directly (not registry skills):
 * a customer session, an admin token, and a checkout-ready cart.
 */
export const CUSTOMER_AUTHENTICATED: SkillKey = { entity: "customer", state: "authenticated" };
export const ADMIN_AUTHENTICATED: SkillKey = { entity: "admin", state: "authenticated" };
export const CART_CHECKOUT_READY: SkillKey = { entity: "cart", state: "checkout-ready" };

function skillKeyEquals(a: SkillKey, b: SkillKey): boolean {
  return a.entity === b.entity && a.state === b.state;
}

/** A matcher on a rejection body — carries the expected envelope AND a predicate
 * so tests (and a future phase-C minter) can both assert the exact shape and
 * check an observed body. */
export interface RejectionBodyMatcher {
  /** The exact rejection envelope (from gate-contract.ts for the auth gate). */
  expected: unknown;
  /** Does an observed response body satisfy this rejection? */
  matches(body: unknown): boolean;
}

export interface ExpectedRejection {
  status: number;
  bodyMatcher: RejectionBodyMatcher;
}

export interface BusinessRule {
  /** Stable human-readable id. */
  id: string;
  /** Endpoint patterns; a trailing `*` means prefix-match (Express-glob, exactly
   * as `gate-contract.ts` matchers and `build-oas.ts#matchesGate` interpret them). */
  patterns: readonly string[];
  /** HTTP methods this rule constrains. */
  methods: readonly string[];
  /** Preconditions that must hold for the happy path (entity@state keys). */
  preconditions: readonly SkillKey[];
  /** The rejection produced when a precondition is unmet, or null when this rule
   * only arranges prep (no distinct rejection envelope of its own). */
  expectedRejection: ExpectedRejection | null;
  /** Reason string surfaced when a happy-path precondition is UNSATISFIABLE
   * (e.g. a guest can never mutate a cart). Sourced here so the drop reason lives
   * with the rule, not inline in the planner. */
  unsatisfiableReason?: (method: string, endpoint: string) => string;
}

/** Express-glob match, mirroring gate-contract semantics (see build-oas.ts#matchesGate). */
function patternMatches(pattern: string, endpoint: string): boolean {
  if (pattern.endsWith("*")) return endpoint.startsWith(pattern.slice(0, -1));
  return endpoint === pattern;
}

function ruleApplies(rule: BusinessRule, method: string, endpoint: string): boolean {
  if (!rule.methods.includes(method.toUpperCase())) return false;
  return rule.patterns.some((p) => patternMatches(p, endpoint));
}

// ---------------------------------------------------------------------------
// The customer-auth gate rejection, DERIVED from gate-contract.ts (never hardcoded).
// ---------------------------------------------------------------------------

const GATE_REJECTION: ExpectedRejection = {
  status: GATE_UNAUTHORIZED_STATUS,
  bodyMatcher: {
    expected: GATE_UNAUTHORIZED_BODY,
    matches(body: unknown): boolean {
      if (typeof body !== "object" || body === null) return false;
      const b = body as { type?: unknown; message?: unknown };
      return b.type === GATE_UNAUTHORIZED_BODY.type && b.message === GATE_UNAUTHORIZED_BODY.message;
    },
  },
};

// ---------------------------------------------------------------------------
// The rules table.
// ---------------------------------------------------------------------------

export const BUSINESS_RULES: readonly BusinessRule[] = [
  // Customer-auth gate — matchers/methods/status/body all come from gate-contract.ts.
  // A cart or payment-collection MUTATION requires a logged-in customer; without
  // one the requireCustomerAuth middleware rejects with GATE_UNAUTHORIZED_STATUS.
  {
    id: "customer-auth-gate",
    patterns: GATE_MATCHERS,
    methods: GATE_METHODS,
    preconditions: [CUSTOMER_AUTHENTICATED],
    expectedRejection: GATE_REJECTION,
    unsatisfiableReason: (method, endpoint) =>
      `${method} ${endpoint}: requires an authenticated customer (requireCustomerAuth gate, gate-contract.ts); no skill can arrange a customer session for an unauthenticated context`,
  },
  // Checkout completion additionally needs a checkout-ready cart (a shipping
  // method selected AND a payment session created — appendCheckoutReadyResolvers).
  // The auth precondition is already covered by the gate rule above (the pattern
  // overlaps `/store/carts*`); this rule adds the prep precondition.
  {
    id: "checkout-complete-ready",
    patterns: ["/store/carts/{id}/complete"],
    methods: ["POST"],
    preconditions: [CUSTOMER_AUTHENTICATED, CART_CHECKOUT_READY],
    expectedRejection: null,
  },
  // Every /admin/* endpoint requires an admin token.
  {
    id: "admin-token",
    patterns: ["/admin/*"],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    preconditions: [ADMIN_AUTHENTICATED],
    expectedRejection: null,
  },
];

// ---------------------------------------------------------------------------
// Lookups.
// ---------------------------------------------------------------------------

/** All preconditions that apply to a step, de-duplicated across matching rules. */
export function preconditionsFor(method: string, endpoint: string): SkillKey[] {
  const out: SkillKey[] = [];
  for (const rule of BUSINESS_RULES) {
    if (!ruleApplies(rule, method, endpoint)) continue;
    for (const pre of rule.preconditions) {
      if (!out.some((k) => skillKeyEquals(k, pre))) out.push(pre);
    }
  }
  return out;
}

function hasPrecondition(method: string, endpoint: string, key: SkillKey): boolean {
  return preconditionsFor(method, endpoint).some((k) => skillKeyEquals(k, key));
}

/** True when a step is behind the customer-auth gate (matches the gate rule). */
export function requiresCustomerAuth(method: string, endpoint: string): boolean {
  return hasPrecondition(method, endpoint, CUSTOMER_AUTHENTICATED);
}

/** True when a step targets an admin endpoint (needs an admin token). */
export function requiresAdminAuth(method: string, endpoint: string): boolean {
  return hasPrecondition(method, endpoint, ADMIN_AUTHENTICATED);
}

/** True when a step needs the checkout-ready chain (shipping method + payment session). */
export function requiresCheckoutReadyCart(method: string, endpoint: string): boolean {
  return hasPrecondition(method, endpoint, CART_CHECKOUT_READY);
}

/** The unauthorized status the customer-auth gate returns (from gate-contract.ts).
 * Exposed so the planner sources the `401` magic number here, not inline. */
export const CUSTOMER_AUTH_REJECTION_STATUS = GATE_UNAUTHORIZED_STATUS;

/**
 * The expected rejection for a step whose `violated` precondition is unmet, or
 * null when this precondition has no distinct rejection envelope. The auth-gate
 * rejection is sourced from gate-contract.ts.
 */
export function expectedRejectionFor(
  method: string,
  endpoint: string,
  violated: SkillKey
): ExpectedRejection | null {
  for (const rule of BUSINESS_RULES) {
    if (!ruleApplies(rule, method, endpoint)) continue;
    if (!rule.expectedRejection) continue;
    if (rule.preconditions.some((k) => skillKeyEquals(k, violated))) return rule.expectedRejection;
  }
  return null;
}

/** The drop reason for a step whose happy-path precondition is unsatisfiable
 * (sourced from the matching rule), or null when no rule supplies one. */
export function unsatisfiableReasonFor(method: string, endpoint: string): string | null {
  for (const rule of BUSINESS_RULES) {
    if (!ruleApplies(rule, method, endpoint)) continue;
    if (rule.unsatisfiableReason) return rule.unsatisfiableReason(method, endpoint);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth-gated resources (placeholder ids for unauthenticated negative steps).
// ---------------------------------------------------------------------------

/**
 * Each customer-auth-gated resource (one per GATE_MATCHER) maps to the generator
 * scope var that holds its id and the placeholder bound when an unauthenticated
 * negative (4xx) step can never create it — the gate 4xx's on the path prefix
 * BEFORE any resource lookup, so a placeholder id reproduces the asserted status.
 */
interface GatedResource {
  /** The gate matcher this resource sits behind (one of GATE_MATCHERS). */
  matcher: string;
  scopeVar: string;
  placeholderId: string;
}

const GATED_RESOURCES: readonly GatedResource[] = [
  { matcher: "/store/carts*", scopeVar: "cartId", placeholderId: "cart_unauthorized" },
  { matcher: "/store/payment-collections*", scopeVar: "paymentCollectionId", placeholderId: "paycol_unauthorized" },
];

// Guard: every gated resource must correspond to a real GATE_MATCHER, so this
// table can't silently drift from the contract.
for (const r of GATED_RESOURCES) {
  if (!(GATE_MATCHERS as readonly string[]).includes(r.matcher)) {
    throw new Error(`business-rules: gated resource "${r.scopeVar}" references unknown gate matcher "${r.matcher}"`);
  }
}

/** Scope vars whose standalone resolver must MUTATE an auth-gated resource — they
 * are unreachable unauthenticated, so a negative (4xx) guest step binds a
 * placeholder id instead of resolving them. */
export function isAuthGatedResourceVar(varName: string): boolean {
  return GATED_RESOURCES.some((r) => r.scopeVar === varName);
}

/** The placeholder id bound for an auth-gated resource var in an unauthenticated
 * negative step; falls back to `<var>_unauthorized` for any other var. */
export function placeholderIdFor(varName: string): string {
  return GATED_RESOURCES.find((r) => r.scopeVar === varName)?.placeholderId ?? `${varName}_unauthorized`;
}

// ---------------------------------------------------------------------------
// Auth derivation helpers.
// ---------------------------------------------------------------------------

/**
 * A step asserting the customer-auth rejection status (from gate-contract.ts)
 * under a customer token must reach the gate WITHOUT a valid session, or the
 * always-on setup handshake makes it 200. Returns true when the planner should
 * downgrade that one step from a customer token to publishable-key only.
 */
export function expectsCustomerAuthRejection(auth: AuthRequirement, expectedStatus: number): boolean {
  return auth === "customer-token" && expectedStatus === CUSTOMER_AUTH_REJECTION_STATUS;
}

// ---------------------------------------------------------------------------
// Phase-C seam.
// ---------------------------------------------------------------------------

/**
 * TODO(phase-C): systematic failure-path minting. Given a rule, this will one day
 * return brand-new negative test candidates that exercise its expected-rejection
 * column (a guest hitting a gated mutation, an admin call with no token, …).
 * Deferred deliberately: minting new candidates is a separate, larger design step
 * than centralizing the precondition knowledge. Returns `[]` for now so the seam
 * exists without changing any emitted spec.
 */
export function mirrorFailureCandidatesFor(_rule: BusinessRule): never[] {
  return [];
}
