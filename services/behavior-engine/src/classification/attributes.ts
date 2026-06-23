/**
 * Deterministic emergent attributes — derived from STEP CONTENT ONLY
 * (endpoint + status). This is the heart of the "persona is emergent" claim.
 *
 * GUARDRAIL (CLAUDE.md §8): this module must NEVER read
 * `role_observed` or the `session_id` source tag. The status code is part of the
 * flow content (a response the backend produced); the JWT role is not. A
 * `SignatureStep`-like input (method, endpoint, status) is all this sees.
 *
 * Three rule variants live here so the validation step can measure each
 * status-derived signal's contribution as a delta:
 *   - ENDPOINT-ONLY baseline: requires_auth from auth/identity endpoints only.
 *   - CART-SIGNAL rule: baseline OR a *successful* (2xx) cart/checkout mutation.
 *   - READ-SIGNAL rule (ADR 0006, the production rule): cart-signal OR a
 *     *successful* (2xx) response on an auth-gated read (proof-via-gate: the
 *     endpoint 401's for a guest) OR an auth-DEPENDENT read (proof-via-resource-
 *     ownership: `GET /store/shipping-options` / `GET /store/orders/{id}` 404 for
 *     a guest, but a 2xx proves an owned cart/order, hence a token).
 *
 * Premise: a *genuinely unauthenticated* guest cart mutation
 * 4xx's (the requireCustomerAuth gate, ADR 0003/0004); a 2xx cart mutation
 * implies a held token — a customer signal. The SAME logic extends to the
 * endpoints the backend auth-gates (ADR 0006): a guest 401's on `GET /store/orders`
 * and on `/store/customers/me` (the customer-account endpoint — gated for *every*
 * method, read OR profile update), so a 2xx there is equally proof of a held token.
 * Confirmed against the live data: guest `POST /store/carts`, `GET /store/orders`,
 * `GET /store/customers/me`, and `POST /store/customers/me` all return 401; a
 * customer returns 2xx. The set is deliberately conservative — only endpoints that
 * 401 for a guest, so a 2xx is *proof*. `GET /store/orders/{id}` is EXCLUDED: a
 * guest gets 404 (order-by-id lookup is permitted), so a 2xx there does not prove
 * a token.
 */

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
 * An auth-gated endpoint (ADR 0006): one the live backend returns `401` for
 * without a customer token, so a 2xx on it proves a held token. Conservative by
 * design — `/store/orders/{id}` is omitted (a guest gets 404, not 401, because
 * order-by-id lookup is permitted), as is `/store/shipping-options` (cart-gated,
 * not auth-gated). // VERIFY against live backend (gate enforcement).
 *
 * `/store/customers/me` is gated for ALL methods, not just GET: the profile
 * *update* (`POST /store/customers/me`) 401's for a guest exactly as the read
 * does, so a 2xx on it is equally proof of a held token. Restricting this to GET
 * was the bug that let authenticated profile-management flows (whose only step is
 * `POST /store/customers/me`) classify as guests. `/store/orders` stays GET-only
 * (the listing is the gated read; there is no guest-401 write analog).
 */
function isAuthGatedRead(method: string, endpoint: string): boolean {
  if (endpoint === "/store/customers/me" || endpoint.startsWith("/store/customers/me/")) {
    return true;
  }
  return method.toUpperCase() === "GET" && endpoint === "/store/orders";
}

/**
 * An auth-DEPENDENT read (ADR 0006): a `GET` that returns `404` (not `401`) for a
 * guest, so it is NOT proof-via-gate — but a *successful* (2xx) response still
 * proves the requester held a customer token, because the resource it reads can
 * only exist for an authenticated owner:
 *   - `GET /store/shipping-options` 2xx ⟹ the requester owned a cart (a guest
 *     cannot create one — the requireCustomerAuth gate 401's `POST /store/carts`),
 *   - `GET /store/orders/{id}` 2xx ⟹ the requester owned that order (a guest gets
 *     404).
 * This is distinct from `isAuthGatedRead` (proof-via-gate: the endpoint 401's for
 * a guest). Without it, an all-GET sub-pattern of a real customer session — e.g.
 * [products, shipping-options, orders/{id}] mined from a checkout session that
 * dropped its cart-mutation steps — classifies as a guest flow that no guest can
 * actually execute (the generated cart/order resolvers then 401).
 */
function isAuthDependentRead(method: string, endpoint: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  return (
    endpoint === "/store/shipping-options" ||
    endpoint === "/store/orders/{id}" ||
    endpoint.startsWith("/store/orders/")
  );
}

/**
 * Derive attributes under one of three rule variants (ADR 0006).
 *
 * @param useCartSignal when true, a *successful* (2xx) cart/checkout mutation
 *   also sets `requires_auth`. When false, only auth/identity endpoints do (the
 *   endpoint-only baseline).
 * @param useReadSignal when true, a *successful* (2xx) auth-gated read also sets
 *   `requires_auth` (the read analog of the cart signal). The production rule
 *   sets both flags; validation scores all three combinations as a delta.
 */
export function deriveAttributes(
  steps: AttrStep[],
  useCartSignal: boolean,
  useReadSignal = false
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
    if (
      useCartSignal &&
      isSuccess(step.status) &&
      isCartMutation(method, step.endpoint)
    ) {
      requiresAuth = true;
    }
    if (
      useReadSignal &&
      isSuccess(step.status) &&
      (isAuthGatedRead(method, step.endpoint) || isAuthDependentRead(method, step.endpoint))
    ) {
      requiresAuth = true;
    }
  }

  return { requires_auth: requiresAuth, is_admin: isAdmin, has_errors: hasErrors };
}
