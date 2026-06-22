import { StoreSession, type SortOrder } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance, pick } from "../util/random.js";

const SORT_ORDERS: SortOrder[] = ["title", "-title", "created_at", "-created_at"];
const BROWSE_LIMIT = 5; // 12 seeded products ⇒ ≥3 pages, so page 2 always has results.

/** Exercises the `product-categories`, `?category_id[]=`, `?order=`, and `?offset=` query-param families that no other flow covers. */
export async function runCategoryBrowse(
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

  await session.listCategories();
  const categoryId = pick(session.categories);
  if (categoryId) {
    await session.browseByCategory(categoryId);
  } else {
    await session.browseProducts();
  }

  const sortOrder = pick(SORT_ORDERS);
  if (sortOrder && chance(0.2)) {
    await session.sortProducts(sortOrder);
  }

  if (chance(0.3)) {
    await session.browsePage(BROWSE_LIMIT, BROWSE_LIMIT);
  }

  await session.viewMultipleProducts(2 + Math.floor(Math.random() * 3));

  return session;
}
