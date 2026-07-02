import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { TrafficConfig } from "../config/config.js";
import { generateNarrative } from "../llm/narrative.js";

/**
 * Registered-customer full checkout — the HOLDOUT.
 *
 * This is the ONLY place the full register -> login -> browse -> cart ->
 * line-items -> checkout -> complete sequence is realized. It must never appear
 * in flows/. The behavior engine is expected to rediscover it from the combined log stream
 * with no prior knowledge, proving genuine discovery.
 *
 * To avoid holdout starvation, the core checkout backbone is GUARANTEED here;
 * the LLM narrative only varies the browsing actions around it. Every call
 * to this function that reaches the network completes a real customer order.
 */
export async function runCustomerCheckout(
  client: MedusaClient,
  cfg: TrafficConfig
): Promise<{ session: StoreSession; completed: boolean }> {
  const session = new StoreSession(client);

  await session.loadRegions();

  // LLM-varied browsing / cart fiddling BEFORE the guaranteed checkout. We pull
  // a customer narrative but only replay its pre-checkout, non-auth actions so
  // the order itself is never skipped.
  const narrative = await generateNarrative(cfg, "customer");
  const preCheckout = narrative.filter((a) =>
    ["browse_products", "view_product"].includes(a)
  );
  if (preCheckout.length === 0) {
    preCheckout.push("browse_products", "view_product");
  }
  for (const action of preCheckout) {
    if (action === "browse_products") {
      await session.browseProducts();
    } else {
      await session.viewProduct();
    }
  }

  // Guaranteed registered-customer checkout backbone.
  const login = await session.register();
  if (!login.ok || !session.token) {
    return { session, completed: false };
  }
  await session.viewProfile();
  const cart = await session.createCart();
  if (!cart.ok || !session.cartId) {
    return { session, completed: false };
  }
  await session.addItem();
  if (Math.random() < 0.5) {
    await session.addItem();
  }
  await session.ensureCheckoutReady();
  const complete = await session.complete();
  await session.viewOrder();
  await session.viewOrders();

  return { session, completed: complete.ok };
}
