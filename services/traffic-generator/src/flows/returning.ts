import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";
import { chance } from "../util/random.js";
import { maybeApplyPromo, type PromoConfig } from "./promo.js";
/** Full set of intents a returning (authenticated) session can take. */
export type ReturningIntent =
  | "bounce"
  | "browse"
  | "cartAbandon"
  | "checkoutAbandon"
  | "reviseAbandon"
  | "buy";

/**
 * Checkout abandonment cut weighted toward the payment step (Baymard Institute
 * data: ~60% abandon at payment, ~25% at address, ~15% at shipping).
 */
function baymardCut(stepsLength: number): number {
  const r = Math.random();
  if (r < 0.25) return 1;
  if (r < 0.40) return 2;
  return 2 + Math.ceil(Math.random() * (stepsLength - 2));
}

/**
 * Returning-customer flow. Logs into a PRE-EXISTING pooled account — login
 * only, never register — preserving sign-in/sign-up decoupling.
 *
 * Token reuse: ~55% of returning sessions skip re-authentication because the
 * customer's JWT is still live (they just open the app). These sessions emit
 * no `login` step — their log starts directly with `browse_products` or
 * `view_product`, which is a distinct behavioral signal from fresh logins.
 */
export async function runReturningFlow(
  client: MedusaClient,
  account: PoolAccount,
  intent: ReturningIntent,
  promo?: PromoConfig
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();

  // ~55% of sessions reuse a live JWT and skip the auth endpoint entirely.
  if (account.token && chance(0.55)) {
    session.useExistingToken(account.email, account.token);
  } else {
    await session.loginExisting(account.email, account.password);
    if (session.token) account.token = session.token;
  }

  await session.browseProducts();
  await session.viewProduct();
  if (chance(0.4)) await session.viewProduct();

  if (intent === "bounce" || intent === "browse") {
    return session;
  }

  await session.createCart();
  await session.addItem();

  if (intent === "reviseAbandon") {
    await session.addItem();
    if (chance(0.5)) await session.addItem();
    await session.updateItem();
    await session.removeItem();
    return session;
  }

  if (chance(0.35)) await session.addItem();
  if (chance(0.25)) await session.updateItem();
  await maybeApplyPromo(session, promo);

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
    const cut = baymardCut(steps.length);
    for (const step of steps.slice(0, cut)) await step();
    return session;
  }

  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
