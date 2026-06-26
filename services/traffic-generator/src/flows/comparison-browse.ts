import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance } from "../util/random.js";

const SEARCH_QUERIES = ["shirt", "shoes", "bag", "watch", "phone case", "jacket", "dress", "wallet"];

function pickQuery(): string {
  return SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
}

/**
 * The high view_product count per session (4–8 vs. the 1–2 of regular browse)
 * is the distinguishing log signal. This is always a non-purchasing session;
 * ~20% add one item to cart but abandon (the "save for later" pattern).
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

  if (chance(0.6)) {
    await session.searchProducts(pickQuery());
  } else {
    await session.browseProducts();
  }

  const firstPass = 4 + Math.floor(Math.random() * 3);
  await session.viewMultipleProducts(firstPass);

  if (chance(0.5)) {
    const r = Math.random();
    if (r < 0.4) {
      await session.filterProducts();
    } else if (r < 0.7) {
      await session.sortProducts("title");
    } else {
      await session.searchProducts(pickQuery());
    }
    const secondPass = 1 + Math.floor(Math.random() * 3);
    await session.viewMultipleProducts(secondPass);
  }

  if (session.token && chance(0.2)) {
    await session.createCart();
    await session.addItem();
  }

  return session;
}
