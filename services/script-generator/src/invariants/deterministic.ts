/**
 * Deterministic business invariants for endpoint outcomes whose response
 * contract is stable in this repo. These are not guessed from traffic and do
 * not carry volatile values: they assert discriminators, presence/absence, and
 * safe enum-ish outcomes only.
 */
import type { Candidate, CandidateStep } from "../load.js";
import type { ApprovedTemplateName, FieldInvariant, Invariant, TemplateInvariant } from "./types.js";

const CUSTOMER_LOGIN = "POST /auth/customer/emailpass";
const ADMIN_LOGIN = "POST /auth/user/emailpass";
const CART_UPDATE = "POST /store/carts/{id}";
const CART_CREATE = "POST /store/carts";
const CART_LINE_ITEM_ADD = "POST /store/carts/{id}/line-items";
const CART_LINE_ITEM_UPDATE = "POST /store/carts/{id}/line-items/{id}";
const CART_SHIPPING_METHODS = "POST /store/carts/{id}/shipping-methods";
const CHECKOUT_COMPLETE = "POST /store/carts/{id}/complete";
const ADMIN_ORDER_CANCEL = "POST /admin/orders/{id}/cancel";

function title(step: CandidateStep): string {
  return `${step.method} ${step.endpoint}`;
}

function inv(stepTitle: string, over: Omit<FieldInvariant, "stepTitle" | "source" | "verified">): FieldInvariant {
  return {
    stepTitle,
    source: "deterministic",
    verified: true,
    ...over,
  };
}

function tmpl(
  stepTitle: string,
  template: ApprovedTemplateName,
  path: string,
  rationale: string,
  polarity: "success" | "error" = "success"
): TemplateInvariant {
  return {
    kind: "template",
    stepTitle,
    template,
    path,
    rationale,
    polarity,
    source: "deterministic",
    verified: true,
  };
}

function isSuccess(step: CandidateStep): boolean {
  return step.expected_status >= 200 && step.expected_status < 300;
}

function hasInvalidPromoCode(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const codes = (payload as { promo_codes?: unknown }).promo_codes;
  if (!Array.isArray(codes) || codes.length === 0) return false;
  return codes.every(
    (code) =>
      typeof code === "string" &&
      /(^|[_-])(invalid|bad|wrong|fake|unknown|not[_-]?seeded|do[_-]?not[_-]?seed)([_-]|$)/i.test(code)
  );
}

function deterministicInvariantsForStep(candidate: Candidate, step: CandidateStep): Invariant[] {
  const stepTitle = title(step);

  if ((stepTitle === CUSTOMER_LOGIN || stepTitle === ADMIN_LOGIN) && isSuccess(step)) {
    return [
      tmpl(stepTitle, "auth_success_token", "", "successful email/password login returns a non-empty session token"),
      inv(stepTitle, {
        path: "token.length",
        matcher: "toBeGreaterThan",
        expected: 0,
        rationale: "successful email/password login returns a non-empty session token",
        polarity: "success",
      }),
    ];
  }

  if (stepTitle === CUSTOMER_LOGIN && step.expected_status >= 400) {
    return [
      tmpl(stepTitle, "auth_failure_error", "", "failed customer login returns an error body and does not mint a token", "error"),
      inv(stepTitle, {
        path: "token",
        matcher: "toBeUndefined",
        rationale: "failed customer login must not mint a session token",
        polarity: "error",
      }),
      inv(stepTitle, {
        path: "message",
        matcher: "toBeDefined",
        rationale: "failed customer login returns a Medusa error message",
        polarity: "error",
      }),
      inv(stepTitle, {
        path: "type",
        matcher: "toBeDefined",
        rationale: "failed customer login returns a Medusa error type",
        polarity: "error",
      }),
    ];
  }

  if (stepTitle === CART_UPDATE && isSuccess(step) && hasInvalidPromoCode(step.request_payload)) {
    return [
      tmpl(stepTitle, "cart_totals_balance", "cart", "cart total equals item + shipping + tax - discount"),
      tmpl(stepTitle, "invalid_promotion_not_applied", "cart", "an invalid promo code must not apply a promotion or discount", "error"),
      inv(stepTitle, {
        path: "cart.promotions.length",
        matcher: "toBe",
        expected: 0,
        rationale: "an invalid promo code must be omitted from the cart promotions",
        polarity: "error",
      }),
      inv(stepTitle, {
        path: "cart.discount_total",
        matcher: "toBe",
        expected: 0,
        rationale: "an invalid promo code must not silently apply a discount",
        polarity: "error",
      }),
    ];
  }

  if (
    [CART_CREATE, CART_UPDATE, CART_LINE_ITEM_ADD, CART_LINE_ITEM_UPDATE, CART_SHIPPING_METHODS].includes(stepTitle) &&
    isSuccess(step)
  ) {
    const invariants: Invariant[] = [
      tmpl(stepTitle, "cart_totals_balance", "cart", "cart total equals item + shipping + tax - discount"),
    ];
    if (stepTitle === CART_LINE_ITEM_ADD || stepTitle === CART_LINE_ITEM_UPDATE) {
      invariants.push(tmpl(stepTitle, "cart_has_items", "cart", "line item mutation leaves the cart with at least one item"));
    }
    return invariants;
  }

  if (stepTitle === CHECKOUT_COMPLETE && !candidate.attributes.has_errors && isSuccess(step)) {
    return [
      tmpl(stepTitle, "checkout_returns_order", "", "checkout completion must return an order-shaped success body"),
      tmpl(stepTitle, "order_totals_balance", "order", "created order total equals item + shipping + tax - discount"),
      inv(stepTitle, {
        path: "type",
        matcher: "toBe",
        expected: "order",
        rationale: "checkout completion returns HTTP 200 for both conversion and cart-shaped failure; type==='order' proves an order was placed",
        polarity: "success",
      }),
      inv(stepTitle, {
        path: "order.id",
        matcher: "toBeDefined",
        rationale: "checkout completion success includes the created order object",
        polarity: "success",
      }),
      inv(stepTitle, {
        path: "order.status",
        matcher: "toBe",
        expected: "pending",
        rationale: "newly placed Medusa orders start in pending status",
        polarity: "success",
      }),
    ];
  }

  if (stepTitle === ADMIN_ORDER_CANCEL && isSuccess(step)) {
    return [
      tmpl(stepTitle, "admin_order_canceled", "", "admin order cancellation must persist order.status='canceled'"),
      inv(stepTitle, {
        path: "order.status",
        matcher: "toBe",
        expected: "canceled",
        rationale: "admin cancel returns a canceled order",
        polarity: "success",
      }),
    ];
  }

  return [];
}

function dedupeKey(inv: Invariant): string {
  if (inv.kind === "template") return JSON.stringify([inv.stepTitle, inv.kind, inv.template, inv.path]);
  return JSON.stringify([inv.stepTitle, inv.path, inv.matcher, inv.expected ?? null]);
}

export function deterministicInvariantsForCandidate(candidate: Candidate): Invariant[] {
  return candidate.steps.flatMap((step) => deterministicInvariantsForStep(candidate, step));
}

export function deterministicInvariantsByStep(candidate: Candidate): Map<string, Invariant[]> {
  const byStep = new Map<string, Invariant[]>();
  for (const invariant of deterministicInvariantsForCandidate(candidate)) {
    const list = byStep.get(invariant.stepTitle) ?? [];
    list.push(invariant);
    byStep.set(invariant.stepTitle, list);
  }
  return byStep;
}

export function mergeInvariantMaps(...maps: Map<string, Invariant[]>[]): Map<string, Invariant[]> {
  const merged = new Map<string, Map<string, Invariant>>();
  for (const map of maps) {
    for (const [stepTitle, invariants] of map) {
      const byKey = merged.get(stepTitle) ?? new Map<string, Invariant>();
      for (const invariant of invariants) {
        byKey.set(dedupeKey(invariant), invariant);
      }
      merged.set(stepTitle, byKey);
    }
  }

  const out = new Map<string, Invariant[]>();
  for (const [stepTitle, byKey] of merged) {
    out.set(stepTitle, [...byKey.values()]);
  }
  return out;
}
