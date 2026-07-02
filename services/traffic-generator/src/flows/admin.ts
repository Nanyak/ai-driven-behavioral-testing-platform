import { AdminSession } from "../api/admin-session.js";
import type { MedusaClient } from "../http/client.js";
import { chance } from "../util/random.js";

/** The admin role is established naturally by the auth endpoint; no role header is sent. */
export async function runAdminFlow(
  client: MedusaClient,
  email: string,
  password: string
): Promise<AdminSession> {
  const session = new AdminSession(client, email, password);

  const login = await session.login();
  if (!login.ok) {
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
  // createProduct returns a richer result; execute the request once like every
  // other deliberate admin action in this demo flow.
  if (chance(0.4)) {
    operations.push(async () => (await session.createProduct()).res);
  }

  for (const operation of operations) {
    await operation();
  }

  return session;
}

/** Fulfills a real pooled order — the prerequisite that makes the order returnable in the F3 path. */
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
 * The admin operates the full return lifecycle on a real order the customer
 * inquired about in the E flow — the cross-role linkage the behavior engine joins on. The
 * storefront has no customer return endpoint, so filing the return is itself
 * an admin action here. Each step degrades to a logged non-2xx rather than
 * crashing (version-sensitive).
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
  const items: any[] = order.ok ? order.body?.order?.items ?? [] : [];
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
 * ADR 0003: the third admin reversal archetype next to refund (F3) and cancel
 * (F5) — the operator declines a requested return instead of receiving and
 * refunding it. Reuses the F3 begin → request-items → request sequence to put
 * the return into `requested` state, then `cancelReturn(...)` rather than the
 * receive/refund tail. Each step degrades to a logged non-2xx rather than
 * crashing.
 */
export async function runAdminReturnRejectFlow(
  client: MedusaClient,
  email: string,
  password: string,
  orderId: string
): Promise<{ session: AdminSession; returnId?: string; filed: boolean; rejected: boolean }> {
  const session = new AdminSession(client, email, password);
  if (!(await session.login()).ok) {
    return { session, filed: false, rejected: false };
  }
  await session.listReturns();
  const location = await session.resolveStockLocation();

  const order = await session.getOrder(orderId);
  const items: any[] = order.ok ? order.body?.order?.items ?? [] : [];
  if (items.length === 0) {
    return { session, filed: false, rejected: false };
  }
  const returnItems = [{ id: items[0].id, quantity: 1 }];

  const { returnId } = await session.beginReturn(orderId, location);
  if (!returnId) {
    return { session, filed: false, rejected: false };
  }
  await session.requestReturnItems(returnId, returnItems);
  const filed = (await session.confirmReturnRequest(returnId)).ok;

  let rejected = false;
  if (filed) {
    rejected = (await session.cancelReturn(returnId)).ok;
  }
  return { session, returnId, filed, rejected };
}

/** A fulfilled order cannot be canceled directly on this build, so callers pass unfulfilled orders. */
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
