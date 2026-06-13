import { StoreSession } from "../actions.js";
import type { MedusaClient } from "../client.js";
import type { PoolAccount } from "../state.js";
import { chance } from "../noise.js";
import type { ShopIntent } from "./guest.js";

/**
 * Returning-customer flow (plan §3, §4 B/C2). Logs into a PRE-EXISTING pooled
 * account with `loginExisting` — **login only, never register**. This is the
 * sequence that decouples sign-in from sign-up in the data (plan §1.4): it emits
 * `login` with no `register`, the mirror image of the Stage-0 signup-only
 * sessions, which is what lets Phase 7 separate the two behaviors. It is safe to
 * script because it is NOT the holdout (the holdout is register→login→checkout,
 * LLM-only, in personas/customer-llm.ts).
 *
 * The pooled account's token is refreshed on each login so later stages (order
 * status, returns) can reuse it.
 */
export async function runReturningFlow(
  client: MedusaClient,
  account: PoolAccount,
  intent: ShopIntent,
  validPromoCode?: string
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();
  await session.loginExisting(account.email, account.password);
  if (session.token) {
    account.token = session.token;
  }

  await session.browseProducts();
  await session.viewProduct();
  if (chance(0.4)) await session.viewProduct();

  if (intent === "bounce" || intent === "browse") {
    return session;
  }

  await session.createCart();
  await session.addItem();
  if (chance(0.35)) await session.addItem();
  if (chance(0.25)) await session.updateItem();
  if (validPromoCode && chance(0.25)) await session.applyPromoCode(validPromoCode);

  if (intent === "cartAbandon") {
    return session;
  }

  if (intent === "checkoutAbandon") {
    const steps = [
      () => session.setAddress(),
      () => session.addShipping(),
      () => session.createPaymentCollection(),
      () => session.createPaymentSession(),
    ];
    const cut = 1 + Math.floor(Math.random() * steps.length);
    for (const step of steps.slice(0, cut)) {
      await step();
    }
    return session;
  }

  // buy — guaranteed complete returning-customer order.
  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
