import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount, PoolOrder } from "../orchestration/state.js";
import { chance } from "../util/random.js";

/** References an actual pooled order, never a fabricated id. */
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
  if (!session.token) {
    return session;
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

/** The repeated view_order calls against the same order_id are the distinguishing log signal vs. the single-check orderStatus flow. */
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
  if (!session.token) {
    return session;
  }

  session.lastOrderId = order.orderId;

  await session.viewOrders();
  const checkCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < checkCount; i++) {
    await session.viewOrder();
  }

  return session;
}

/**
 * The storefront profile page is read-only: saved addresses live in localStorage
 * and there is no profile-update or add-address API call (verified against the
 * live storefront), so the only authenticated footprint is GET /store/customers/me.
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
  if (!session.token) {
    return session;
  }

  await session.viewProfile();
  if (chance(0.6)) {
    await session.browseProducts();
  }

  return session;
}
