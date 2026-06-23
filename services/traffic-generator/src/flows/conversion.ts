import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";

export type ConversionIntent = "convertBuy" | "convertAbandon" | "wallBounce";

/**
 * Produces the `role_observed:[guest, customer]` 401→auth→200 pivot that the behavior engine's
 * "highest-privilege attribute reached" rule is built to classify.
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
  await session.createCart();

  if (intent === "wallBounce") {
    return session;
  }

  await session.loginExisting(account.email, account.password);
  if (session.token) account.token = session.token;
  await session.createCart();
  await session.addItem();

  if (intent === "convertAbandon") {
    return session;
  }

  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
