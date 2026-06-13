import { StoreSession } from "../actions.js";
import type { MedusaClient } from "../client.js";
import type { PoolAccount, PoolOrder } from "../state.js";
import { chance } from "../noise.js";

/**
 * Order-status / track-order flow (plan §4 D1). Returning identity: login →
 * view_orders → view a REAL prior order → (sometimes) reorder. References an
 * actual pooled order, never a fabricated id.
 */
export async function runOrderStatusFlow(
  client: MedusaClient,
  account: PoolAccount,
  order: PoolOrder,
  reorderProb = 0.2
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();
  await session.loginExisting(account.email, account.password);
  if (session.token) {
    account.token = session.token;
  }

  await session.viewOrders();
  session.lastOrderId = order.orderId;
  await session.viewOrder();

  if (chance(reorderProb)) {
    const variant = order.items.find((i) => i.variantId)?.variantId;
    if (variant) {
      await session.reorder(variant);
    }
  }

  return session;
}

/**
 * Profile & address management (plan §4 D2). Returning identity, no purchase:
 * login → view profile → update profile → (sometimes) add an address.
 */
export async function runProfileMgmtFlow(
  client: MedusaClient,
  account: PoolAccount
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loginExisting(account.email, account.password);
  if (session.token) {
    account.token = session.token;
  }

  await session.viewProfile();
  await session.updateProfile();
  if (chance(0.6)) {
    await session.addAddress();
  }

  return session;
}
