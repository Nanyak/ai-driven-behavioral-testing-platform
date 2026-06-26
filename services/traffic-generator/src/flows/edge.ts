import type { MedusaClient } from "../http/client.js";
import type { StepResult } from "../http/step.js";
import { newCustomerEmail } from "../config/ids.js";
import { shuffleInPlace } from "../util/random.js";

/** Deliberately triggers 4xx/5xx so the behavior engine has a healthy supply of error flows to mine. */
export async function runEdgeFlow(client: MedusaClient): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const record = (action: string, method: string, path: string, status: number, ok: boolean) =>
    steps.push({ action, method, path, status, ok });

  // Deterministic bad-login failure path: a clean region read, then a
  // wrong-password login -> 401. The behavior engine keys a failure flow on the
  // FIRST error step of a session, so leading EVERY edge session with this pair
  // guarantees a stable 2-step `[GET /store/regions, POST /auth/customer/emailpass]`
  // bad-login flow that clears the support floor. (A lone login attempt is a
  // single step and gets filtered as "not a flow"; the other edge cases below
  // become non-first errors and still feed the error-flow supply.)
  const regions = await client.request("GET", "/store/regions");
  record("load_regions", "GET", "/store/regions", regions.status, regions.ok);
  const badLogin = await client.request("POST", "/auth/customer/emailpass", {
    body: { email: newCustomerEmail(), password: "wrong-password" },
  });
  record("bad_login", "POST", "/auth/customer/emailpass", badLogin.status, badLogin.ok);

  const cases: Array<() => Promise<void>> = [
    async () => {
      const res = await client.request("GET", "/admin/products", { publishable: false });
      record("admin_no_token", "GET", "/admin/products", res.status, res.ok);
    },
    async () => {
      const res = await client.request("GET", "/store/products/prod_does_not_exist");
      record("invalid_product", "GET", "/store/products/{id}", res.status, res.ok);
    },
    async () => {
      const res = await client.request("GET", "/store/customers/me");
      record("profile_no_token", "GET", "/store/customers/me", res.status, res.ok);
    },
  ];

  shuffleInPlace(cases);
  const count = 2 + Math.floor(Math.random() * Math.min(3, cases.length - 1));
  for (const runCase of cases.slice(0, count)) {
    await runCase();
  }

  return steps;
}
