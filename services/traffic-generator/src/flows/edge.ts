import type { MedusaClient } from "../client.js";
import type { StepResult } from "../actions.js";
import { newCustomerEmail } from "../ids.js";
import { shuffleInPlace } from "../noise.js";

/**
 * Edge-case flow (plan §5 step 5 / §8.5). Deliberately triggers 4xx/5xx so
 * Phase 7 has a healthy supply of error flows to mine. Each session runs a
 * randomized subset so the error mix is not perfectly uniform.
 */
export async function runEdgeFlow(client: MedusaClient): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const record = (action: string, method: string, path: string, status: number, ok: boolean) =>
    steps.push({ action, method, path, status, ok });

  const cases: Array<() => Promise<void>> = [
    // Admin call without a token -> 401.
    async () => {
      const res = await client.request("GET", "/admin/products", { publishable: false });
      record("admin_no_token", "GET", "/admin/products", res.status, res.ok);
    },
    // Line item against an invalid cart id -> 404.
    async () => {
      const res = await client.request("POST", "/store/carts/cart_invalid123/line-items", {
        body: { variant_id: "variant_invalid", quantity: 1 },
      });
      record("invalid_cart_line_item", "POST", "/store/carts/{id}/line-items", res.status, res.ok);
    },
    // Complete with an invalid/empty payload on a real but empty cart -> 400/422.
    async () => {
      const created = await client.request("POST", "/store/carts", { body: {} });
      const cartId = created.ok ? created.body?.cart?.id : undefined;
      if (cartId) {
        const res = await client.request("POST", `/store/carts/${cartId}/complete`);
        record("complete_empty_cart", "POST", "/store/carts/{id}/complete", res.status, res.ok);
      }
    },
    // Product detail for a non-existent id -> 404.
    async () => {
      const res = await client.request("GET", "/store/products/prod_does_not_exist");
      record("invalid_product", "GET", "/store/products/{id}", res.status, res.ok);
    },
    // Login with an invalid password -> 401.
    async () => {
      const res = await client.request("POST", "/auth/customer/emailpass", {
        body: { email: newCustomerEmail(), password: "wrong-password" },
      });
      record("bad_login", "POST", "/auth/customer/emailpass", res.status, res.ok);
    },
    // Customer profile without a token -> 401.
    async () => {
      const res = await client.request("GET", "/store/customers/me");
      record("profile_no_token", "GET", "/store/customers/me", res.status, res.ok);
    },
  ];

  // Run a randomized subset (3-5 cases) per edge session.
  shuffleInPlace(cases);
  const count = 3 + Math.floor(Math.random() * Math.min(3, cases.length - 2));
  for (const runCase of cases.slice(0, count)) {
    await runCase();
  }

  return steps;
}
