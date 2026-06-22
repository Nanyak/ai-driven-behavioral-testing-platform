/**
 * Shared gate contract (ADR 0004 decision #3).
 *
 * Single source of truth for the `requireCustomerAuth` gate's matchers,
 * methods, and `401` envelope. Imported by BOTH `middlewares.ts` (to
 * *enforce* the gate) and `services/golden/openapi/build-oas.ts` (to
 * *document* it in the augmented OpenAPI spec). Enforcement and
 * documentation cannot drift because they read the same literals.
 *
 * Deliberately dependency-free (no `@medusajs/*` imports) so this module
 * can also be loaded standalone under `tsx`/node from `build-oas.ts`,
 * which lives outside the Medusa backend package.
 */

/**
 * Path matchers gated by `requireCustomerAuth`. These are STRING matchers,
 * not RegExp: Medusa's middleware loader coerces every matcher with
 * `String(matcher)`, so a RegExp here would become a literal path string
 * Express can never match and the gate would silently never run. The
 * trailing `*` is required to also cover sub-paths (e.g. `/line-items`,
 * `/shipping-methods`, `/complete`, `/payment-sessions`).
 */
export const GATE_MATCHERS = ["/store/carts*", "/store/payment-collections*"] as const;

/** HTTP methods the gate applies to. GET is intentionally left open. */
export const GATE_METHODS = ["POST", "PATCH", "DELETE"] as const;

export const GATE_UNAUTHORIZED_STATUS = 401;

export interface GateUnauthorized {
  type: "unauthorized";
  message: string;
}

export const GATE_UNAUTHORIZED_BODY: GateUnauthorized = {
  type: "unauthorized",
  message: "Cart and checkout operations require a customer account. Please sign in.",
};
