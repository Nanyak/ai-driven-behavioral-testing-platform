import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../client.js";
import type { PoolAccount } from "../state.js";
import { chance } from "../util/random.js";

const SEARCH_QUERIES = ["shirt", "shoes", "bag", "watch", "jacket", "pants", "dress"];

function pickQuery(): string {
  return SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
}

/**
 * Multi-item cart flow — user adds 3–5 items across multiple browse cycles
 * before checking out. Common on Lazada for household goods and fashion where
 * shoppers combine items across categories to hit free-shipping thresholds.
 *
 * The alternating browse→add→browse→add pattern is the distinguishing log
 * signal: multiple browse_products and filter_products calls interleaved with
 * add_item calls, producing carts with 3+ line items.
 */
export async function runMultiItemFlow(
  client: MedusaClient,
  account: PoolAccount | null,
  intent: "cartAbandon" | "buy",
  validPromoCode?: string
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

  // Cycle 1: search entry → view → add first item.
  await session.searchProducts(pickQuery());
  await session.viewProduct();
  await session.createCart();
  await session.addItem();

  // Cycle 2: filter a different category → add second item.
  await session.filterProducts();
  await session.viewProduct();
  await session.addItem();

  // Cycle 3: browse listing → view → add third item.
  await session.browseProducts();
  if (chance(0.6)) await session.viewProduct();
  await session.addItem();

  // Cycle 4 (optional ~50%): one more search-and-add.
  if (chance(0.5)) {
    await session.searchProducts(pickQuery());
    if (chance(0.5)) await session.viewProduct();
    await session.addItem();
  }

  // Post-add cart actions.
  if (chance(0.35)) await session.updateItem();               // adjust quantity
  if (chance(0.2)) {                                          // swap variant
    await session.removeItem();
    await session.addItem();
  }

  if (validPromoCode && chance(0.3)) await session.applyPromoCode(validPromoCode);

  if (intent === "cartAbandon") {
    return session;
  }

  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
