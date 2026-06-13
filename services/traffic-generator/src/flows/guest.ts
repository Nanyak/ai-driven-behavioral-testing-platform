import { StoreSession } from "../actions.js";
import type { MedusaClient } from "../client.js";
import {
  chance,
  maybeAbandon,
  runSteps,
  shuffleInPlace,
  type NoiseConfig,
} from "../noise.js";

/**
 * Scripted guest backbone (plan §8.5):
 *   regions -> products -> product detail -> create cart -> add line item ->
 *   (address -> shipping -> payment) -> complete -> view order.
 *
 * Guest checkout completes with only an email on the cart — the session never
 * touches /auth/customer/* or /store/customers, so its JWT role stays null.
 * The registered-customer auth sub-flow is intentionally absent here; it lives
 * ONLY in personas/customer-llm.ts (the holdout, plan §8.4).
 */
export async function runGuestFlow(client: MedusaClient, noise: NoiseConfig): Promise<StoreSession> {
  const session = new StoreSession(client);

  await session.loadRegions();

  // Browse phase — order optionally shuffled (list vs. detail interleaving).
  const browse = [
    () => session.browseProducts(),
    () => session.viewProduct(),
    () => session.viewProduct(),
  ];
  if (noise.shuffle) {
    shuffleInPlace(browse);
  }
  await runSteps(browse, noise);

  await session.createCart();
  await session.addItem();
  if (chance(0.4)) {
    await session.updateItem();
  }

  // Persona contamination: a guest occasionally pokes a customer-only endpoint
  // (will 401) — simulates a user toggling between modes (plan §8.3).
  if (noise.contaminate && chance(noise.contaminateProb)) {
    await session.viewProfile();
  }

  // Checkout backbone — subject to abandonment.
  const checkout = [
    () => session.setAddress(),
    () => session.addShipping(),
    () => session.createPaymentCollection(),
    () => session.createPaymentSession(),
    () => session.complete(),
    () => session.viewOrder(),
  ];

  await runSteps(maybeAbandon(checkout, noise), noise);

  return session;
}

/** Intent leaves of the §4 taxonomy a guest (or login-only returning) can take. */
export type ShopIntent = "bounce" | "browse" | "cartAbandon" | "checkoutAbandon" | "buy";

/**
 * Intent-driven guest shopper (plan §4 A/B/C1). One function realizes the
 * distinct taxonomy leaves so the sampler can request exactly the situation it
 * drew, instead of one backbone that randomly abandons. Never authenticates —
 * JWT role stays null. `buy` is a GUARANTEED guest checkout (no abandonment) so
 * Stage 1 actually produces poolable orders.
 */
export async function runGuestShop(
  client: MedusaClient,
  intent: ShopIntent,
  validPromoCode?: string
): Promise<StoreSession> {
  const session = new StoreSession(client);
  await session.loadRegions();
  await session.browseProducts();

  if (intent === "bounce") {
    await session.viewProduct();
    if (chance(0.4)) await session.viewProduct();
    return session;
  }

  if (intent === "browse") {
    if (chance(0.3)) await session.searchProducts("shirt");
    if (chance(0.25)) await session.filterProducts();
    await session.viewProduct();
    if (chance(0.5)) await session.viewProduct();
    return session;
  }

  // Cart-bearing intents.
  await session.viewProduct();
  await session.createCart();
  await session.addItem();
  if (chance(0.35)) await session.addItem();
  if (chance(0.25)) await session.updateItem();
  if (chance(0.15)) await session.removeItem();
  if (validPromoCode && chance(0.25)) await session.applyPromoCode(validPromoCode);

  if (intent === "cartAbandon") {
    return session;
  }

  if (intent === "checkoutAbandon") {
    // Start checkout, then drop at a realistic point (plan §4.1 Baymard shape).
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

  // buy — guaranteed complete guest order.
  await session.ensureCheckoutReady();
  await session.complete();
  await session.viewOrder();
  return session;
}
