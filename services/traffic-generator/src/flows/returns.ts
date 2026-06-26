import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount, PoolOrder } from "../orchestration/state.js";

/**
 * The storefront exposes no customer-facing return/refund endpoint — order
 * lifecycle is admin-operated (see docs/adr) — so the customer can only log in
 * and look at the order they want to return. The orchestrator flags that order
 * so an admin refund session (F3) settles the SAME order_id: the cross-role
 * linkage the behavior engine discovers (customer placed + inquired, admin refunded).
 */
export async function runReturnInquiryFlow(
  client: MedusaClient,
  account: PoolAccount,
  order: PoolOrder
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loginExisting(account.email, account.password);
  if (session.token) {
    account.token = session.token;
  }
  if (!session.token) {
    return session;
  }

  await session.viewOrders();
  session.lastOrderId = order.orderId;
  await session.viewOrder();
  return session;
}
