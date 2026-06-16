import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../client.js";
import type { PoolAccount } from "../state.js";

/** Intents a guest→sign-in conversion session can take (Theme 1). */
export type ConversionIntent = "convertBuy" | "convertAbandon" | "wallBounce";

/**
 * Guest → sign-in conversion flow (Theme 1). A logged-out shopper browses, tries
 * to add to cart, hits the auth wall, then either signs in and continues or
 * abandons at the wall. This produces the `role_observed:[guest, customer]`
 * 401→auth→200 pivot that Phase 7's "highest-privilege attribute reached" rule
 * (§10.3) is built to classify.
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

  // Guest browse — no token, role null.
  await session.loadRegions();
  await session.browseProducts();
  await session.viewProduct();

  // The wall: one guest `createCart()` attempt → 401 (the noise retry fix
  // prevents a retry storm). No register here — the holdout is LLM-only.
  await session.createCart();

  if (intent === "wallBounce") {
    // Hit the wall, left — a guest session carrying a single 401.
    return session;
  }

  // Sign in with a pooled account (now a customer), then continue past the wall.
  await session.loginExisting(account.email, account.password);
  if (session.token) account.token = session.token;
  await session.createCart();
  await session.addItem();

  if (intent === "convertAbandon") {
    return session;
  }

  // convertBuy — complete the order the wall almost cost.
  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
