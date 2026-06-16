import { AdminSession } from "../api/admin-session.js";
import type { MedusaClient } from "../client.js";
import { maybeAbandon, runSteps, type NoiseConfig } from "../noise.js";
import { chance } from "../util/random.js";

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

/**
 * Order fulfillment (plan §4 F2 / §5 Stage 2a). Fulfills a real pooled order —
 * the prerequisite that makes the order returnable in the F3 path. Reports
 * whether the fulfillment succeeded so the orchestrator can mark the order
 * fulfilled.
 */
export async function runAdminFulfillFlow(
  client: MedusaClient,
  email: string,
  password: string,
  orderId: string
): Promise<{ session: AdminSession; fulfilled: boolean }> {
  const session = new AdminSession(client, email, password);
  if (!(await session.login()).ok) {
    return { session, fulfilled: false };
  }
  await session.listOrders();
  const fulfilled = (await session.createFulfillment(orderId)).ok;
  return { session, fulfilled };
}

/**
 * Return/refund processing for a FULFILLED order (plan §4 F3 / §5 Stage 2b). The
 * admin operates the full return lifecycle on a real order the customer inquired
 * about in the E flow — the cross-role linkage Phase 7 joins on. The storefront
 * has no customer return endpoint, so filing the return is itself an admin
 * action here. The order is already fulfilled (Stage 2a F2) — a return cannot
 * cover more than was fulfilled. Each step degrades to a logged non-2xx rather
 * than crashing (version-sensitive).
 *
 *   begin return (+location) -> request-items -> request   [return filed]
 *     -> receive -> receive-items -> receive/confirm        [refund settled]
 *
 * Returns whether a return was `filed` (request confirmed) and `refunded`
 * (receipt confirmed) plus the `returnId` for pool linkage.
 */
export async function runAdminRefundFlow(
  client: MedusaClient,
  email: string,
  password: string,
  orderId: string
): Promise<{ session: AdminSession; returnId?: string; filed: boolean; refunded: boolean }> {
  const session = new AdminSession(client, email, password);
  if (!(await session.login()).ok) {
    return { session, filed: false, refunded: false };
  }
  await session.listReturns();
  const location = await session.resolveStockLocation();

  // Resolve order line-item ids fresh — cart line-item ids in the pool differ.
  const order = await session.getOrder(orderId);
  const items: any[] = order.ok ? order.body?.order?.items ?? [] : []; // admin order shape; only id/quantity used
  if (items.length === 0) {
    return { session, filed: false, refunded: false };
  }
  const returnItems = [{ id: items[0].id, quantity: 1 }];

  const { returnId } = await session.beginReturn(orderId, location);
  if (!returnId) {
    return { session, filed: false, refunded: false };
  }
  await session.requestReturnItems(returnId, returnItems);
  const filed = (await session.confirmReturnRequest(returnId)).ok;

  let refunded = false;
  if (filed) {
    await session.receiveReturn(returnId);
    await session.receiveReturnItems(returnId, returnItems);
    refunded = (await session.confirmReturnReceipt(returnId)).ok;
  }
  return { session, returnId, filed, refunded };
}

/**
 * Order cancellation for an UNFULFILLED order (plan §4 F5 / §5 Stage 2b). The
 * reversal path for "customer changed their mind before it shipped": the admin
 * cancels the order, which reverses the authorized payment. A fulfilled order
 * cannot be canceled directly on this build, so callers pass unfulfilled orders.
 */
export async function runAdminCancelFlow(
  client: MedusaClient,
  email: string,
  password: string,
  orderId: string
): Promise<{ session: AdminSession; canceled: boolean }> {
  const session = new AdminSession(client, email, password);
  if (!(await session.login()).ok) {
    return { session, canceled: false };
  }
  await session.listOrders();
  await session.getOrder(orderId);
  const canceled = (await session.cancelOrder(orderId)).ok;
  return { session, canceled };
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
