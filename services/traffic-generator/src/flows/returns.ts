import { StoreSession } from "../actions.js";
import type { MedusaClient } from "../client.js";
import type { PoolAccount, PoolOrder } from "../state.js";

/**
 * Customer return request against a REAL completed order (plan §4 E / §5 Stage
 * 2). Returning identity. The resulting `{orderId, returnId}` is pushed to the
 * return pool by the orchestrator so an admin refund session (F3) can settle the
 * SAME order_id — the cross-role linkage Phase 7 discovers.
 */
export async function runReturnFlow(
  client: MedusaClient,
  account: PoolAccount,
  order: PoolOrder
): Promise<{ session: StoreSession; returnId?: string; filed: boolean }> {
  const session = new StoreSession(client);
  await session.loginExisting(account.email, account.password);
  if (session.token) {
    account.token = session.token;
  }

  await session.viewOrders();
  const { returnId, res } = await session.requestReturn(order.orderId);
  return { session, returnId, filed: res.ok };
}
