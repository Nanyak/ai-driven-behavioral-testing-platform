import { StoreSession } from "../actions.js";
import type { MedusaClient } from "../client.js";
import type { PoolAccount } from "../state.js";
import { chance } from "../noise.js";

export type DirectIntent = "bounce" | "browse" | "cartAbandon" | "buy";

/**
 * Direct product landing flow (share-link / ad traffic). The session starts
 * with view_product — never browse_products — because the user arrived via a
 * shared URL pointing to a specific item (WhatsApp, TikTok, Facebook ad).
 *
 * This is a major Shopee/Lazada traffic source. The absence of a leading
 * browse_products step is the distinguishing log signal that separates
 * share-link arrivals from organic category browsers.
 */
export async function runDirectLandingFlow(
  client: MedusaClient,
  account: PoolAccount | null,
  intent: DirectIntent,
  validPromoCode?: string
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();

  // Returning users (account != null) may already have a live JWT.
  if (account) {
    if (account.token && chance(0.55)) {
      session.useExistingToken(account.email, account.token);
    } else {
      await session.loginExisting(account.email, account.password);
      if (session.token) account.token = session.token;
    }
  }

  // Pre-fetch product IDs silently so the first recorded step is view_product,
  // not browse_products. This mirrors a client landing on a product URL directly.
  await session.prefetchProductIds();
  await session.viewProduct();

  if (intent === "bounce") {
    // Many share-link bounces: view the product, maybe scroll to similar items, leave.
    if (chance(0.35)) await session.viewProduct();
    return session;
  }

  if (intent === "browse") {
    // Liked the product, explored more.
    if (chance(0.6)) await session.viewProduct();
    if (chance(0.45)) await session.browseProducts();
    if (chance(0.35)) await session.viewProduct();
    return session;
  }

  // Cart-bearing intents.
  await session.createCart();
  await session.addItem();
  if (chance(0.25)) await session.addItem(); // added a related item

  if (intent === "cartAbandon") {
    return session;
  }

  // buy
  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
