import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance } from "../util/random.js";
import { maybeApplyPromo, type PromoConfig } from "./promo.js";

const SEARCH_QUERIES = ["shirt", "shoes", "bag", "watch", "jacket", "pants", "dress"];

function pickQuery(): string {
  return SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
}

/**
 * The alternating browse→add→browse→add pattern is the distinguishing log
 * signal: multiple browse_products and filter_products calls interleaved with
 * add_item calls, producing carts with 3+ line items.
 */
export async function runMultiItemFlow(
  client: MedusaClient,
  account: PoolAccount | null,
  intent: "cartAbandon" | "buy",
  promo?: PromoConfig
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
  if (!session.token) {
    return session;
  }

  await session.searchProducts(pickQuery());
  await session.viewProduct();
  await session.createCart();
  await session.addItem();

  await session.filterProducts();
  await session.viewProduct();
  await session.addItem();

  await session.browseProducts();
  if (chance(0.6)) await session.viewProduct();
  await session.addItem();

  if (chance(0.5)) {
    await session.searchProducts(pickQuery());
    if (chance(0.5)) await session.viewProduct();
    await session.addItem();
  }

  if (chance(0.35)) await session.updateItem();
  if (chance(0.2)) {
    await session.removeItem();
    await session.addItem();
  }

  await maybeApplyPromo(session, promo);

  if (intent === "cartAbandon") {
    return session;
  }

  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
