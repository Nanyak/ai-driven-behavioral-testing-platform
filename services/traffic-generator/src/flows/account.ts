import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount, PoolOrder } from "../orchestration/state.js";
import { chance } from "../util/random.js";

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
 * Repeat order-status flow — user checks delivery progress 3–5 times in one
 * session. Common on Shopee/Lazada immediately after placing an order (tracking
 * anxiety). The repeated view_order calls against the same order_id are the
 * distinguishing log signal vs. the single-check orderStatus flow.
 */
export async function runRepeatOrderStatusFlow(
  client: MedusaClient,
  account: PoolAccount,
  order: PoolOrder
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();

  if (account.token && chance(0.6)) {
    session.useExistingToken(account.email, account.token);
  } else {
    await session.loginExisting(account.email, account.password);
    if (session.token) account.token = session.token;
  }

  session.lastOrderId = order.orderId;

  // Check order list once, then poll the specific order 3–5 times.
  await session.viewOrders();
  const checkCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < checkCount; i++) {
    await session.viewOrder();
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
