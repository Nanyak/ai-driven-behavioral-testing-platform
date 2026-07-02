import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance } from "../util/random.js";

export type DirectIntent = "bounce" | "browse" | "cartAbandon" | "buy";

/**
 * The session starts with view_product — never browse_products — because the
 * user arrived via a shared URL pointing to a specific item. The absence of a
 * leading browse_products step is the distinguishing log signal that separates
 * share-link arrivals from organic category browsers.
 */
export async function runDirectLandingFlow(
  client: MedusaClient,
  account: PoolAccount | null,
  intent: DirectIntent
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();

  if (account) {
    if (account.token && chance(0.55)) {
      session.useExistingToken(account.email, account.token);
    } else {
      await session.loginExisting(account.email, account.password);
      if (session.token) account.token = session.token;
    }
  }

  // Pre-fetch product IDs silently so the first recorded step is view_product,
  // not browse_products — mirrors a client landing on a product URL directly.
  await session.prefetchProductIds();
  await session.viewProduct();

  if (intent === "bounce") {
    if (chance(0.35)) await session.viewProduct();
    return session;
  }

  if (intent === "browse") {
    if (chance(0.6)) await session.viewProduct();
    if (chance(0.45)) await session.browseProducts();
    if (chance(0.35)) await session.viewProduct();
    return session;
  }
  if (!session.token) {
    return session;
  }

  const cart = await session.createCart();
  if (!cart.ok || !session.cartId) {
    return session;
  }
  await session.addItem();
  if (chance(0.25)) await session.addItem();

  if (intent === "cartAbandon") {
    return session;
  }

  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
