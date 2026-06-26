import type { ApprovedTemplateName, TemplateInvariant } from "./types.js";

const TEMPLATE_FN: Record<ApprovedTemplateName, string> = {
  auth_success_token: "assertAuthSuccessToken",
  auth_failure_error: "assertAuthFailureError",
  cart_totals_balance: "assertCartTotalsBalance",
  cart_has_items: "assertCartHasItems",
  invalid_promotion_not_applied: "assertInvalidPromotionNotApplied",
  checkout_returns_order: "assertCheckoutReturnsOrder",
  order_totals_balance: "assertOrderTotalsBalance",
  admin_order_canceled: "assertAdminOrderCanceled",
};

export function templateFunctionName(template: ApprovedTemplateName): string {
  return TEMPLATE_FN[template];
}

export function templateImportNames(invariants: TemplateInvariant[]): string[] {
  return [...new Set(invariants.map((inv) => templateFunctionName(inv.template)))].sort();
}

export function renderTemplateInvariant(bodyVar: string, inv: TemplateInvariant, index: number): string[] {
  const targetVar = `${bodyVar}Template${index}`;
  const label = `${inv.stepTitle} — ${inv.template}: ${inv.rationale}`;
  return [
    `    // invariant (${inv.source} template): ${inv.rationale}`,
    `    const ${targetVar} = getPath(${bodyVar}, ${JSON.stringify(inv.path)});`,
    `    ${templateFunctionName(inv.template)}(${targetVar}, ${JSON.stringify(label)});`,
  ];
}

function readPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = (current as { length: number }).length;
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function totalBalancePass(value: unknown): boolean {
  const node = asRecord(value);
  if (!node) return false;
  const total = num(node.total);
  const itemTotal = num(node.item_total);
  const shippingTotal = num(node.shipping_total);
  const taxTotal = num(node.tax_total);
  const discountTotal = num(node.discount_total);
  if (total === null || itemTotal === null || shippingTotal === null || taxTotal === null || discountTotal === null) {
    return false;
  }
  return total === itemTotal + shippingTotal + taxTotal - discountTotal;
}

export function evaluateTemplate(template: ApprovedTemplateName, value: unknown): boolean {
  const node = asRecord(value);
  switch (template) {
    case "auth_success_token":
      return typeof readPath(value, "token") === "string" && (readPath(value, "token") as string).length > 0;
    case "auth_failure_error":
      return readPath(value, "token") === undefined && readPath(value, "message") !== undefined;
    case "cart_totals_balance":
    case "order_totals_balance":
      return totalBalancePass(value);
    case "cart_has_items":
      return Array.isArray(node?.items) && node.items.length > 0;
    case "invalid_promotion_not_applied":
      return Array.isArray(node?.promotions) && node.promotions.length === 0 && node.discount_total === 0;
    case "checkout_returns_order":
      return readPath(value, "type") === "order" && readPath(value, "order.id") !== undefined;
    case "admin_order_canceled":
      return readPath(value, "order.status") === "canceled";
  }
}

export function businessInvariantRuntimeSource(): string {
  return `import { expect } from "@playwright/test";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  return value as Record<string, unknown>;
}

function readPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\\[(\\d+)\\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = (current as { length: number }).length;
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function amount(value: unknown, path: string, label: string): number {
  expect(typeof value, \`\${label}: \${path} must be numeric\`).toBe("number");
  expect(Number.isFinite(value as number), \`\${label}: \${path} must be finite\`).toBe(true);
  return value as number;
}

function assertTotalsBalance(value: unknown, label: string): void {
  const node = asRecord(value, label);
  const total = amount(node.total, "total", label);
  const itemTotal = amount(node.item_total, "item_total", label);
  const shippingTotal = amount(node.shipping_total, "shipping_total", label);
  const taxTotal = amount(node.tax_total, "tax_total", label);
  const discountTotal = amount(node.discount_total, "discount_total", label);
  expect(total, label).toBe(itemTotal + shippingTotal + taxTotal - discountTotal);
}

export function assertAuthSuccessToken(value: unknown, label: string): void {
  expect(readPath(value, "token"), label).toEqual(expect.any(String));
  expect((readPath(value, "token") as string).length, label).toBeGreaterThan(0);
}

export function assertAuthFailureError(value: unknown, label: string): void {
  expect(readPath(value, "token"), label).toBeUndefined();
  expect(readPath(value, "message"), label).toBeDefined();
}

export function assertCartTotalsBalance(value: unknown, label: string): void {
  assertTotalsBalance(value, label);
}

export function assertOrderTotalsBalance(value: unknown, label: string): void {
  assertTotalsBalance(value, label);
}

export function assertCartHasItems(value: unknown, label: string): void {
  const node = asRecord(value, label);
  expect(Array.isArray(node.items), \`\${label}: items must be an array\`).toBe(true);
  expect((node.items as unknown[]).length, label).toBeGreaterThan(0);
}

export function assertInvalidPromotionNotApplied(value: unknown, label: string): void {
  const node = asRecord(value, label);
  expect(Array.isArray(node.promotions), \`\${label}: promotions must be an array\`).toBe(true);
  expect((node.promotions as unknown[]).length, label).toBe(0);
  expect(node.discount_total, label).toBe(0);
}

export function assertCheckoutReturnsOrder(value: unknown, label: string): void {
  expect(readPath(value, "type"), label).toBe("order");
  expect(readPath(value, "order.id"), label).toBeDefined();
}

export function assertAdminOrderCanceled(value: unknown, label: string): void {
  expect(readPath(value, "order.status"), label).toBe("canceled");
}
`;
}
