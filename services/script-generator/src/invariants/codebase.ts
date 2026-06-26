/**
 * Codebase reader (input enrichment for the proposal agent).
 *
 * The OAS tells the agent the response SHAPE; it cannot tell the agent the
 * BEHAVIOR — that lives in handler code. Two sources matter for this stack:
 *
 *   1. `apps/medusa/apps/backend/src/api/gate-contract.ts` — the project's OWN
 *      custom auth gate. Tiny, always fresh, high-signal (it's exactly the
 *      behavior the OAS omits: which mutations require an authenticated customer).
 *   2. `@medusajs/core-flows` workflows in node_modules — the real business logic
 *      for store/admin endpoints (cart completion, order cancel, fulfillment…).
 *      Compiled `dist` JS: large and noisy, so it is read here only to FEED the
 *      behavior-digest generator (digest.ts), never the proposal agent directly.
 *
 * Everything is content-hashed so the two caches (the digest and the per-flow
 * template) invalidate precisely when the underlying code changes — not on a
 * clock. node_modules core-flows is immutable until a dependency bump, so a
 * hash key regenerates a handful of times a year, when Medusa is upgraded.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");

export const GATE_CONTRACT_PATH = resolvePath(
  REPO_ROOT,
  "apps/medusa/apps/backend/src/api/gate-contract.ts"
);
const CORE_FLOWS_DIST = resolvePath(
  REPO_ROOT,
  "apps/medusa/node_modules/@medusajs/core-flows/dist"
);

/**
 * Curated endpoint → core-flows workflow map. Keyed by the EMITTED step title
 * (`${METHOD} ${path-template}`), so it lines up with candidate steps and the
 * digest sections. Best-effort: an endpoint absent from the map simply yields no
 * workflow source (the agent still has the OAS shape + gate). Paths are relative
 * to `@medusajs/core-flows/dist`. Add a row when a new endpoint needs a digest.
 */
const WORKFLOW_MAP: Readonly<Record<string, string>> = {
  "POST /store/carts": "cart/workflows/create-carts.js",
  "POST /store/carts/{id}": "cart/workflows/update-cart.js",
  "POST /store/carts/{id}/line-items": "cart/workflows/add-to-cart.js",
  "POST /store/carts/{id}/line-items/{id}": "cart/workflows/update-line-item-in-cart.js",
  "POST /store/carts/{id}/shipping-methods": "cart/workflows/add-shipping-method-to-cart.js",
  "POST /store/carts/{id}/complete": "cart/workflows/complete-cart.js",
  "GET /store/shipping-options": "cart/workflows/list-shipping-options-for-cart.js",
  "POST /admin/orders/{id}/cancel": "order/workflows/cancel-order.js",
  "POST /admin/orders/{id}/fulfillments": "order/workflows/create-fulfillment.js",
};

/** The emitted step title for a step — the join key across map/digest/candidate. */
export function stepTitle(method: string, endpoint: string): string {
  return `${method} ${endpoint}`;
}

/** Endpoints that have a mapped core-flows workflow (what the digest covers). */
export function mappedEndpoints(): { title: string; workflow: string }[] {
  return Object.entries(WORKFLOW_MAP).map(([title, workflow]) => ({ title, workflow }));
}

/** Absolute path to an endpoint's workflow source, or null when unmapped/absent. */
export function workflowFileFor(method: string, endpoint: string): string | null {
  const rel = WORKFLOW_MAP[stepTitle(method, endpoint)];
  if (!rel) return null;
  const abs = resolvePath(CORE_FLOWS_DIST, rel);
  return existsSync(abs) ? abs : null;
}

/** Best-effort file read — returns null rather than throwing on an absent file. */
export function readSource(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The custom auth-gate source, or null if the file has moved. Always fresh
 * (it's in-repo, tiny) — never digested, fed to the proposal agent verbatim. */
export function readGateContract(): string | null {
  return readSource(GATE_CONTRACT_PATH);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Content hash of a single endpoint's workflow source (for the digest cache
 * key). Empty string when unmapped, so an unmapped endpoint has a stable key. */
export function workflowSourceHash(method: string, endpoint: string): string {
  const src = readSource(workflowFileFor(method, endpoint));
  return src ? sha256(src) : "";
}
