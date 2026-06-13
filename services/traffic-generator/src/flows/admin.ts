import { AdminSession } from "../actions.js";
import type { MedusaClient } from "../client.js";
import { chance, maybeAbandon, runSteps, type NoiseConfig } from "../noise.js";

/**
 * Scripted admin backbone (plan §8.5):
 *   POST /auth/user/emailpass -> list/view/update products -> list orders ->
 *   list customers.
 *
 * The admin role is established naturally by the auth endpoint; no role header
 * is sent. Subsequent /admin/* calls carry the operator JWT.
 */
export async function runAdminFlow(
  client: MedusaClient,
  email: string,
  password: string,
  noise: NoiseConfig
): Promise<AdminSession> {
  const session = new AdminSession(client, email, password);

  const login = await session.login();
  if (!login.ok) {
    // Without a token the rest cannot proceed; the failed login is logged.
    return session;
  }

  const operations = [
    () => session.listProducts(),
    () => session.viewProduct(),
    () => session.listOrders(),
    () => session.listCustomers(),
  ];
  if (chance(0.5)) {
    operations.push(() => session.updateProduct());
  }

  await runSteps(maybeAbandon(operations, noise), noise);

  return session;
}

/** Order fulfillment (plan §4 F2 / §5 Stage 2). Fulfills a real pooled order. */
export async function runAdminFulfillFlow(
  client: MedusaClient,
  email: string,
  password: string,
  orderId: string
): Promise<AdminSession> {
  const session = new AdminSession(client, email, password);
  if (!(await session.login()).ok) {
    return session;
  }
  await session.listOrders();
  await session.createFulfillment(orderId);
  return session;
}

/**
 * Return/refund processing (plan §4 F3 / §5 Stage 2). Settles a real pending
 * return on the SAME order_id the customer touched in the E flow — the cross-
 * role linkage. `returnId` is omitted when no pending return is available.
 */
export async function runAdminRefundFlow(
  client: MedusaClient,
  email: string,
  password: string,
  orderId: string,
  returnId?: string
): Promise<AdminSession> {
  const session = new AdminSession(client, email, password);
  if (!(await session.login()).ok) {
    return session;
  }
  await session.listReturns();
  await session.processRefund(orderId, returnId);
  return session;
}

/** Support lookup (plan §4 F4 / §5 Stage 2): find a customer/order by query. */
export async function runAdminSupportFlow(
  client: MedusaClient,
  email: string,
  password: string,
  query: string
): Promise<AdminSession> {
  const session = new AdminSession(client, email, password);
  if (!(await session.login()).ok) {
    return session;
  }
  await session.searchCustomer(query);
  return session;
}
