import { StoreSession } from "../actions.js";
import type { MedusaClient } from "../client.js";
import type { TrafficConfig } from "../config.js";
import type { ApiResponse } from "../client.js";
import { generateNarrative, type Action, type NarrativeKind } from "./narrative.js";

/**
 * Map one narrative action token to a concrete StoreSession call, resolving IDs
 * at runtime. Returns null for "abandon" (caller stops). complete_checkout runs
 * the full prerequisite chain so an LLM session that decides to buy actually can.
 */
async function execute(session: StoreSession, action: Action): Promise<ApiResponse | null> {
  switch (action) {
    case "browse_products":
      return session.browseProducts();
    case "view_product":
      return session.viewProduct();
    case "register":
      return session.register();
    case "login":
      return session.login();
    case "view_profile":
      return session.viewProfile();
    case "create_cart":
      return session.createCart();
    case "add_item":
      return session.addItem();
    case "update_item":
      return session.updateItem();
    case "remove_item":
      return session.removeItem();
    case "apply_promo":
      return session.applyPromo();
    case "set_address":
      return session.setAddress();
    case "list_shipping":
      return session.listShipping();
    case "add_shipping":
      return session.addShipping();
    case "create_payment_collection":
      return session.createPaymentCollection();
    case "create_payment_session":
      return session.createPaymentSession();
    case "complete_checkout":
      await session.ensureCheckoutReady();
      return session.complete();
    case "view_orders":
      return session.viewOrders();
    case "view_order":
      return session.viewOrder();
    case "abandon":
      return null;
    default:
      return null;
  }
}

/**
 * Generate an LLM (or fallback) narrative and replay it as concrete Store API
 * calls. Used for the general LLM-varied session budget (plan §6).
 */
export async function runLlmSession(
  client: MedusaClient,
  cfg: TrafficConfig,
  kind: NarrativeKind
): Promise<{ session: StoreSession; narrative: Action[] }> {
  const narrative = await generateNarrative(cfg, kind);
  const session = new StoreSession(client);

  for (const action of narrative) {
    const result = await execute(session, action);
    if (result === null && action === "abandon") {
      break;
    }
    // Retry-on-4xx noise, mirroring scripted flows.
    if (result && !result.ok && result.status >= 400 && result.status < 500) {
      await execute(session, action);
    }
  }

  return { session, narrative };
}
