import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../client.js";
import type { PoolAccount } from "../state.js";
import { chance } from "../util/random.js";

const SEARCH_QUERIES = ["shirt", "shoes", "bag", "watch", "phone case", "jacket", "dress", "wallet"];

function pickQuery(): string {
  return SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
}

/**
 * Comparison-browse flow — a user researching 4–8 products before deciding.
 * Common on Shopee/Lazada for electronics, fashion, and home goods.
 *
 * The high view_product count per session (4–8 vs. the 1–2 of regular browse)
 * is the distinguishing log signal. This is always a non-purchasing session;
 * ~20% add one item to cart but abandon (the "save for later" pattern).
 *
 * Entry is search-first ~60% of the time — matching Shopee/Lazada behaviour
 * where most users type a query rather than navigate by category.
 */
export async function runComparisonBrowseFlow(
  client: MedusaClient,
  account: PoolAccount | null
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

  // Entry: search (60%) or category browse (40%).
  if (chance(0.6)) {
    await session.searchProducts(pickQuery());
  } else {
    await session.browseProducts();
  }

  // First comparison pass: 4–6 products.
  const firstPass = 4 + Math.floor(Math.random() * 3);
  await session.viewMultipleProducts(firstPass);

  // Mid-session refinement: filter or search again to narrow results (~50%).
  if (chance(0.5)) {
    if (chance(0.5)) {
      await session.filterProducts();
    } else {
      await session.searchProducts(pickQuery());
    }
    const secondPass = 1 + Math.floor(Math.random() * 3);
    await session.viewMultipleProducts(secondPass);
  }

  // ~20%: add one item to cart then abandon ("save for later").
  if (chance(0.2)) {
    await session.createCart();
    await session.addItem();
  }

  return session;
}
