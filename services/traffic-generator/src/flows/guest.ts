import type { MedusaClient } from "../http/client.js";
import { StoreSession } from "../api/store-session.js";
import { chance } from "../util/random.js";

/** Cart-bearing intents are not available — the storefront requires auth to add to cart. */
export type ShopIntent = "bounce" | "browse";

/** Never authenticates — JWT role stays null. */
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

  if (chance(0.3)) await session.searchProducts("shirt");
  if (chance(0.25)) await session.filterProducts();
  if (chance(0.2)) await session.sortProducts("-created_at");
  if (chance(0.2)) await session.browsePage(5, 5);
  await session.viewProduct();
  if (chance(0.5)) await session.viewProduct();
  return session;
}
