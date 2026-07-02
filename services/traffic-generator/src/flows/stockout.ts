import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance } from "../util/random.js";

export interface LowStockTarget {
  variantId: string;
  productId?: string;
  /** Pinned stocked quantity — the flow adds `stock + 1` to force the 400. */
  stock: number;
}

/**
 * The target is a dedicated, deliberately under-stocked product created once in
 * Stage 0 (`state.lowStockVariantId`), so the over-add 400 is deterministic
 * without contaminating the 12 seeded products' stock.
 */
export async function runStockOutCheckout(
  client: MedusaClient,
  account: PoolAccount,
  target: LowStockTarget
): Promise<StoreSession> {
  const session = new StoreSession(client);

  await session.loadRegions();
  await session.loginExisting(account.email, account.password);
  if (session.token) account.token = session.token;
  if (!session.token) {
    return session;
  }

  if (target.productId) {
    await session.viewProductById(target.productId);
  }

  const cart = await session.createCart();
  if (!cart.ok || !session.cartId) {
    return session;
  }
  await session.addItem(target.variantId, target.stock + 1);

  if (chance(0.4)) {
    return session;
  }

  await session.addItem(target.variantId, 1);

  if (chance(0.5)) {
    await session.ensureCheckoutReady();
    await session.complete();
    await session.viewOrder();
  }
  return session;
}
