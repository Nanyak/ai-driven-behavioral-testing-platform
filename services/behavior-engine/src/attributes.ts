/**
 * Deterministic emergent attributes — derived from STEP CONTENT ONLY
 * (endpoint + status). This is the heart of the "persona is emergent" claim.
 *
 * GUARDRAIL (plan §10.3, CLAUDE.md §8): this module must NEVER read
 * `role_observed` or the `session_id` source tag. The status code is part of the
 * flow content (a response the backend produced); the JWT role is not. A
 * `SignatureStep`-like input (method, endpoint, status) is all this sees.
 *
 * Two rule variants live here so the validation step can measure the cart
 * signal's contribution as a delta (plan §Validation):
 *   - ENDPOINT-ONLY baseline: requires_auth from auth/identity endpoints only.
 *   - CART-SIGNAL rule (the spec rule): baseline OR a *successful* (2xx)
 *     cart/checkout mutation.
 *
 * Premise (reworded per PO-2): a *genuinely unauthenticated* guest cart mutation
 * 4xx's (the requireCustomerAuth gate, ADR 0003); a 2xx cart mutation implies a
 * held token — a customer signal. Confirmed against the live data: guest
 * `POST /store/carts` returns 401, customer returns 200.
 */

/** The only fields the classifier may read. */
export interface AttrStep {
  method: string;
  endpoint: string;
  status: number;
}

export interface FlowAttributes {
  requires_auth: boolean;
  is_admin: boolean;
  has_errors: boolean;
}

const AUTH_CUSTOMER = /^\/auth\/customer(\/|$)/;
const CART_MUTATION_PREFIXES = ["/store/carts", "/store/payment-collections"];
const MUTATION_METHODS = new Set(["POST", "PATCH", "DELETE"]);

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** An explicit auth/identity endpoint (`/auth/customer/*` or `/store/customers`). */
function isAuthEndpoint(endpoint: string): boolean {
  return AUTH_CUSTOMER.test(endpoint) || endpoint === "/store/customers";
}

/** A cart/checkout mutation on `/store/carts` or `/store/payment-collections`. */
function isCartMutation(method: string, endpoint: string): boolean {
  if (!MUTATION_METHODS.has(method.toUpperCase())) {
    return false;
  }
  return CART_MUTATION_PREFIXES.some(
    (p) => endpoint === p || endpoint.startsWith(`${p}/`)
  );
}

/**
 * Derive attributes under one of two rule variants.
 *
 * @param useCartSignal when true, a *successful* (2xx) cart/checkout mutation
 *   also sets `requires_auth` (the spec rule). When false, only auth/identity
 *   endpoints do (the endpoint-only baseline).
 */
export function deriveAttributes(
  steps: AttrStep[],
  useCartSignal: boolean
): FlowAttributes {
  let requiresAuth = false;
  let isAdmin = false;
  let hasErrors = false;

  for (const step of steps) {
    const method = step.method.toUpperCase();
    if (step.endpoint.startsWith("/admin/") || step.endpoint === "/admin") {
      isAdmin = true;
    }
    if (step.status >= 400) {
      hasErrors = true;
    }
    if (isAuthEndpoint(step.endpoint)) {
      requiresAuth = true;
    }
    // A step counts toward the cart signal ONLY when 2xx (plan §attributes.ts
    // implementation note). A guest's failed cart attempt is a 4xx and carries
    // has_errors instead, which is correct.
    if (
      useCartSignal &&
      isSuccess(step.status) &&
      isCartMutation(method, step.endpoint)
    ) {
      requiresAuth = true;
    }
  }

  return { requires_auth: requiresAuth, is_admin: isAdmin, has_errors: hasErrors };
}
