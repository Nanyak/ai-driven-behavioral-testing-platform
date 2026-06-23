import type { MedusaClient } from "../http/client.js";
import type { StepResult } from "../http/step.js";
import { newCustomerEmail } from "../config/ids.js";
import { shuffleInPlace } from "../util/random.js";

/** Deliberately triggers 4xx/5xx so the behavior engine has a healthy supply of error flows to mine. */
export async function runEdgeFlow(client: MedusaClient): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const record = (action: string, method: string, path: string, status: number, ok: boolean) =>
    steps.push({ action, method, path, status, ok });

  const cases: Array<() => Promise<void>> = [
    async () => {
      const res = await client.request("GET", "/admin/products", { publishable: false });
      record("admin_no_token", "GET", "/admin/products", res.status, res.ok);
    },
    async () => {
      const res = await client.request("POST", "/store/carts/cart_invalid123/line-items", {
        body: { variant_id: "variant_invalid", quantity: 1 },
      });
      record("invalid_cart_line_item", "POST", "/store/carts/{id}/line-items", res.status, res.ok);
    },
    async () => {
      const created = await client.request("POST", "/store/carts", { body: {} });
      const cartId = created.ok ? created.body?.cart?.id : undefined;
      if (cartId) {
        const res = await client.request("POST", `/store/carts/${cartId}/complete`);
        record("complete_empty_cart", "POST", "/store/carts/{id}/complete", res.status, res.ok);
      }
    },
    async () => {
      const res = await client.request("GET", "/store/products/prod_does_not_exist");
      record("invalid_product", "GET", "/store/products/{id}", res.status, res.ok);
    },
    async () => {
      const res = await client.request("POST", "/auth/customer/emailpass", {
        body: { email: newCustomerEmail(), password: "wrong-password" },
      });
      record("bad_login", "POST", "/auth/customer/emailpass", res.status, res.ok);
    },
    async () => {
      const res = await client.request("GET", "/store/customers/me");
      record("profile_no_token", "GET", "/store/customers/me", res.status, res.ok);
    },
  ];

  shuffleInPlace(cases);
  const count = 3 + Math.floor(Math.random() * Math.min(3, cases.length - 2));
  for (const runCase of cases.slice(0, count)) {
    await runCase();
  }

  return steps;
}
