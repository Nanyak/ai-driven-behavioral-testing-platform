import { StoreSession, type SortOrder } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance, pick } from "../util/random.js";

const SORT_ORDERS: SortOrder[] = ["title", "-title", "created_at", "-created_at"];
const BROWSE_LIMIT = 5; // 12 seeded products ⇒ ≥3 pages, so page 2 always has results.

/**
 * Category-led catalog discovery (Theme 2) — the dominant browse pattern: pick a
 * category, sort it, "load more" (page 2), then drill into a few products. This
 * exercises the `product-categories`, `?category_id[]=`, `?order=`, and `?offset=`
 * query-param families that no other flow covers. Read-only, guest or returning.
 *
 * `account` is null for guests; a pooled account signs in (or reuses its JWT)
 * exactly like the other Stage-1 split-identity browse flows.
 */
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

  // Category-led entry: list categories, pick one, browse it.
  await session.listCategories();
  const categoryId = pick(session.categories);
  if (categoryId) {
    await session.browseByCategory(categoryId);
  } else {
    await session.browseProducts();
  }

  // ~20%: apply a category+sort combo (re-sort the category results).
  if (chance(0.2)) {
    await session.sortProducts(pick(SORT_ORDERS) ?? "title");
  }

  // ~30%: paginate a second page ("load more").
  if (chance(0.3)) {
    await session.browsePage(BROWSE_LIMIT, BROWSE_LIMIT);
  }

  // Drill into 2–4 products.
  await session.viewMultipleProducts(2 + Math.floor(Math.random() * 3));

  return session;
}
