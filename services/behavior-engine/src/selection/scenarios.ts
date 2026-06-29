/**
 * Deterministic business-scenario clustering shared by the generator and review
 * dashboard. Mining may observe many route-level variants of the same intent
 * (especially checkout); review and generation intentionally select one current
 * representative while retaining the other observations as variants.
 */

export interface ScenarioStep {
  method: string;
  endpoint: string;
  expected_status: number;
  request_payload?: unknown;
  request_body_evidence?: {
    fields?: Array<{ path?: string }>;
  };
}

export interface ScenarioCandidate {
  signature: string;
  flow_name: string;
  persona: string;
  support?: number;
  score?: number;
  anomaly_note?: string | null;
  steps: ScenarioStep[];
}

export interface ScenarioRepresentative<T extends ScenarioCandidate> {
  family_key: string;
  scenario_name: string;
  candidate: T;
  /** Includes the representative first, followed by hidden related observations. */
  variants: T[];
}

export interface ScenarioSelection<T extends ScenarioCandidate> {
  representatives: Array<ScenarioRepresentative<T>>;
  collapsed: number;
}

function normalizedText(candidate: ScenarioCandidate): string {
  const evidence = candidate.steps.flatMap((step) => [
    step.endpoint,
    JSON.stringify(step.request_payload ?? ""),
    ...(step.request_body_evidence?.fields ?? []).map((field) => field.path ?? ""),
  ]);
  return `${candidate.flow_name} ${candidate.anomaly_note ?? ""} ${evidence.join(" ")}`.toLowerCase();
}

function areaOf(endpoint: string): string {
  if (endpoint.includes("/payment")) return "payment";
  if (endpoint.includes("/promot") || endpoint.includes("/discount")) return "promotion";
  if (endpoint.includes("/line-items")) return "cart-item";
  if (endpoint.includes("/carts")) return "cart";
  if (endpoint.includes("/shipping")) return "shipping";
  if (endpoint.includes("/auth")) return "authentication";
  if (endpoint.includes("/customers")) return "customer-profile";
  if (endpoint.includes("/returns")) return "return";
  if (endpoint.includes("/fulfill")) return "fulfillment";
  if (endpoint.includes("/orders")) return "order";
  if (endpoint.includes("/products")) return "product";
  return "request";
}

/**
 * Material outcome, rather than the complete status sequence. Repeated retries
 * and optional lookups may differ without becoming separate business tests, but
 * auth, payment, validation, server, and success boundaries never merge.
 */
function outcomeFacet(candidate: ScenarioCandidate): string {
  const failures = candidate.steps.filter((step) => step.expected_status >= 400);
  if (failures.length === 0) return "success";

  const auth = failures.find((step) => step.expected_status === 401 || step.expected_status === 403);
  if (auth) {
    return auth.endpoint.includes("/auth/")
      ? "login-authentication-failure"
      : "protected-resource-authentication-failure";
  }
  const server = failures.find((step) => step.expected_status >= 500);
  if (server) return `server-failure:${areaOf(server.endpoint)}`;
  const payment = failures.find((step) => areaOf(step.endpoint) === "payment");
  if (payment) return `payment-failure:${payment.expected_status}`;
  const promotion = failures.find((step) => areaOf(step.endpoint) === "promotion");
  if (promotion) return `promotion-failure:${promotion.expected_status}`;
  const inventoryText = normalizedText(candidate);
  const item = failures.find((step) => areaOf(step.endpoint) === "cart-item");
  if (item && /(out[- ]?of[- ]?stock|inventory|stock)/.test(inventoryText)) {
    return `out-of-stock:${item.expected_status}`;
  }
  const first = failures[0];
  return `validation-failure:${areaOf(first.endpoint)}:${first.expected_status}`;
}

function scenarioFacet(candidate: ScenarioCandidate, outcome: string): string {
  const endpoints = candidate.steps.map((step) => step.endpoint);
  const text = normalizedText(candidate);
  const has = (part: string) => endpoints.some((endpoint) => endpoint.includes(part));
  const lineItemWrites = candidate.steps.filter(
    (step) =>
      step.method.toUpperCase() === "POST" &&
      step.endpoint.includes("/line-items") &&
      step.expected_status < 400
  ).length;
  const checkout =
    has("/carts/{id}/complete") ||
    has("/payment-collections") ||
    has("/shipping-methods") ||
    (has("/carts") && candidate.steps.some((step) => step.method.toUpperCase() === "POST"));

  if (checkout) {
    if (outcome.includes("authentication-failure")) return "checkout-authentication-failure";
    if (outcome.startsWith("payment-failure")) return "checkout-payment-failure";
    if (outcome.startsWith("promotion-failure")) return "checkout-promotion-failure";
    if (outcome.startsWith("out-of-stock")) return "checkout-out-of-stock";
    if (outcome.includes("cart-item")) return "cart-item-validation-failure";
    if (outcome.includes("cart")) return "cart-update-validation-failure";
    if (/(promo|promotion|discount|coupon)/.test(text)) return "checkout-promotion-applied";
    if (lineItemWrites >= 2 || /(multi[- ]item|multiple items)/.test(text)) {
      return "checkout-multi-item";
    }
    return "checkout-standard";
  }
  if (has("/auth/customer/emailpass/register") || has("/store/customers")) {
    return outcome.includes("authentication-failure")
      ? "registration-profile-authentication-failure"
      : "customer-registration";
  }
  if (has("/auth/") && outcome.includes("authentication-failure")) {
    return "authentication-failure";
  }
  if (has("/admin/returns")) return "admin-return";
  if (has("/fulfillments")) return "admin-fulfillment";
  if (has("/cancel")) return "admin-order-cancellation";
  if (
    candidate.steps.some(
      (step) => step.method.toUpperCase() !== "GET" && step.endpoint.includes("/admin/products")
    )
  ) {
    return "admin-product-update";
  }
  if (has("/products/{id}")) return "catalog-product-details";
  if (has("/products") || has("/product-categories") || has("/regions")) return "catalog-browse";
  return `journey:${areaOf(endpoints.at(-1) ?? "")}`;
}

const SCENARIO_NAMES: Record<string, string> = {
  "checkout-authentication-failure": "Checkout — Authentication failure",
  "checkout-payment-failure": "Checkout — Payment failure",
  "checkout-promotion-failure": "Checkout — Promotion rejected",
  "checkout-out-of-stock": "Checkout — Out-of-stock item",
  "cart-item-validation-failure": "Cart — Item validation failure",
  "cart-update-validation-failure": "Cart — Update validation failure",
  "checkout-promotion-applied": "Checkout — Promotion applied",
  "checkout-multi-item": "Checkout — Multi-item cart",
  "checkout-standard": "Checkout — Standard purchase",
  "registration-profile-authentication-failure": "Registration — Profile authentication failure",
  "customer-registration": "Registration — Customer account",
  "authentication-failure": "Authentication — Login failure",
  "admin-return": "Returns — Full return lifecycle",
  "admin-fulfillment": "Orders — Create fulfillment",
  "admin-order-cancellation": "Orders — Cancellation",
  "admin-product-update": "Catalog — Admin product update",
  "catalog-product-details": "Catalog — Product detail browsing",
  "catalog-browse": "Catalog — Browse products",
};

function deterministicName(facet: string, outcome: string): string {
  const known = SCENARIO_NAMES[facet];
  if (known) return known;
  const area = facet.split(":").at(-1) ?? "journey";
  const title = area.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return outcome === "success" ? title : `${title} — ${outcome.replace(/[:|-]+/g, " ")}`;
}

function statusSignature(candidate: ScenarioCandidate): string {
  return candidate.steps.map((step) => step.expected_status).join(",");
}

function isCompleteJourney(candidate: ScenarioCandidate): number {
  return candidate.steps.some(
    (step) =>
      step.endpoint.includes("/complete") ||
      step.endpoint.includes("/orders/{id}") ||
      step.endpoint.includes("/receive/confirm")
  )
    ? 1
    : 0;
}

function compareImpact<T extends ScenarioCandidate>(
  a: T,
  b: T,
  approvedSignatures: ReadonlySet<string>
): number {
  const approvedDelta =
    Number(approvedSignatures.has(b.signature.toLowerCase())) -
    Number(approvedSignatures.has(a.signature.toLowerCase()));
  if (approvedDelta !== 0) return approvedDelta;
  const completeDelta = isCompleteJourney(b) - isCompleteJourney(a);
  if (completeDelta !== 0) return completeDelta;
  const stepDelta = b.steps.length - a.steps.length;
  if (stepDelta !== 0) return stepDelta;
  const supportDelta = (b.support ?? 0) - (a.support ?? 0);
  if (supportDelta !== 0) return supportDelta;
  const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;
  return a.signature.localeCompare(b.signature);
}

/**
 * Select one current representative per persona + business scenario + material
 * outcome. The returned ordering is deterministic and impact-first.
 */
export function selectBusinessScenarios<T extends ScenarioCandidate>(
  candidates: T[],
  approvedSignatures: ReadonlySet<string> = new Set()
): ScenarioSelection<T> {
  // Exact repeated observations update in place within a mine.
  const exact = new Map<string, T>();
  for (const candidate of candidates) {
    const key = `${candidate.signature.toLowerCase()}:${statusSignature(candidate) || "unknown"}`;
    const prior = exact.get(key);
    if (!prior || compareImpact(prior, candidate, approvedSignatures) > 0) exact.set(key, candidate);
  }

  const families = new Map<string, T[]>();
  for (const candidate of exact.values()) {
    const outcome = outcomeFacet(candidate);
    const facet = scenarioFacet(candidate, outcome);
    const key = `${candidate.persona}|${facet}|${outcome}`;
    const variants = families.get(key) ?? [];
    variants.push(candidate);
    families.set(key, variants);
  }

  const representatives = [...families.entries()].map(([family_key, variants]) => {
    variants.sort((a, b) => compareImpact(a, b, approvedSignatures));
    const outcome = outcomeFacet(variants[0]);
    const facet = family_key.split("|")[1];
    return {
      family_key,
      scenario_name: deterministicName(facet, outcome),
      candidate: variants[0],
      variants,
    };
  });
  representatives.sort(
    (a, b) =>
      compareImpact(a.candidate, b.candidate, approvedSignatures) ||
      a.family_key.localeCompare(b.family_key)
  );
  return {
    representatives,
    collapsed: candidates.length - representatives.length,
  };
}
