import type { MedusaClient } from "../client.js";
import { StoreSession } from "../actions.js";
import { chance } from "../noise.js";

/**
 * Browse-only guest intents (plan §4 A). Cart-bearing intents are not available
 * to unauthenticated sessions — the storefront requires auth to add to cart.
 */
export type ShopIntent = "bounce" | "browse";

/**
 * Intent-driven guest shopper, browse-only (plan §4 A1/A2). Never authenticates —
 * JWT role stays null. Used directly for bounce/browse leaves and as the degrade
 * fallback in Stage-2 flows when no order pool entry is available.
 */
export async function runGuestShop(
  client: MedusaClient,
  intent: ShopIntent
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();
  await session.browseProducts();

  if (intent === "bounce") {
    await session.viewProduct();
    if (chance(0.4)) await session.viewProduct();
    return session;
  }

  // browse
  if (chance(0.3)) await session.searchProducts("shirt");
  if (chance(0.25)) await session.filterProducts();
  await session.viewProduct();
  if (chance(0.5)) await session.viewProduct();
  return session;
}
