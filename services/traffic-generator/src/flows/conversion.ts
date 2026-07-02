import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";

export type ConversionIntent = "convertBuy" | "convertAbandon" | "wallBounce";

/**
 * Models the storefront auth gate: a logged-out shopper clicks cart, the app
 * sends them straight to sign-in, and only after login do we create the cart.
 * The redirect is frontend-only, so the generated API traffic starts at login;
 * no unauthenticated cart request or synthetic `/cart` route is emitted.
 *
 * Holdout rule (CLAUDE.md §5 / §8 #5): this scripted flow authenticates with
 * `loginExisting` on a PRE-EXISTING pooled account — it NEVER calls `register`.
 * The `register → checkout` sequence stays LLM-only in `personas/customer-llm.ts`.
 */
export async function runCartWallConversion(
  client: MedusaClient,
  account: PoolAccount,
  intent: ConversionIntent
): Promise<StoreSession> {
  const session = new StoreSession(client);

  await session.loadRegions();
  await session.browseProducts();
  await session.viewProduct();

  // No register here — the holdout is LLM-only.
  if (intent === "wallBounce") {
    return session;
  }

  await session.loginExisting(account.email, account.password);
  if (session.token) account.token = session.token;
  if (!session.token) {
    return session;
  }
  const cart = await session.createCart();
  if (!cart.ok || !session.cartId) {
    return session;
  }
  await session.addItem();

  if (intent === "convertAbandon") {
    return session;
  }

  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
