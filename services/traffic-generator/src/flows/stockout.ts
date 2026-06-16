import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance } from "../util/random.js";

/** The dedicated limited-stock product the stock-out arc targets (Theme 3). */
export interface LowStockTarget {
  variantId: string;
  productId?: string;
  /** Pinned stocked quantity — the flow adds `stock + 1` to force the 400. */
  stock: number;
}

/**
 * Customer stock-out checkout (Theme 3) — the most realistic checkout failure: a
 * returning customer tries to buy more than the on-hand stock of a low-stock
 * product, hits a 400 `insufficient_inventory` on the add-to-cart call, then
 * either abandons or recovers by adding a single in-stock unit and (sometimes)
 * completing.
 *
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

  if (target.productId) {
    await session.viewProductById(target.productId);
  }

  await session.createCart();

  // The stock-out: ask for one more than is on hand → 400 insufficient_inventory.
  await session.addItem(target.variantId, target.stock + 1);

  // ~40% abandon at the wall; the rest recover with a single in-stock unit.
  if (chance(0.4)) {
    return session;
  }

  await session.addItem(target.variantId, 1);

  // ~50% of recoverers go on to complete the (small) order.
  if (chance(0.5)) {
    await session.ensureCheckoutReady();
    await session.complete();
    await session.viewOrder();
  }
  return session;
}
