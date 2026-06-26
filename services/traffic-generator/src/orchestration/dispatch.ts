import type { MedusaClient } from "../http/client.js";
import type { TrafficConfig } from "../config/config.js";
import { DEFAULT_PASSWORD, StoreSession } from "../api/store-session.js";
import type { StepResult } from "../http/step.js";
import { RunState, type PoolAccount, type PoolOrder } from "./state.js";
import type { SessionType, Identity } from "../config/taxonomy.js";
import { chance } from "../util/random.js";
import { newCustomerEmail } from "../config/ids.js";
import { runGuestShop } from "../flows/guest.js";
import { runReturningFlow } from "../flows/returning.js";
import { runOrderStatusFlow, runRepeatOrderStatusFlow, runProfileMgmtFlow } from "../flows/account.js";
import { runReturnInquiryFlow } from "../flows/returns.js";
import { runDirectLandingFlow, type DirectIntent } from "../flows/direct-landing.js";
import { runComparisonBrowseFlow } from "../flows/comparison-browse.js";
import { runCategoryBrowse } from "../flows/category-browse.js";
import { runMultiItemFlow } from "../flows/multi-item.js";
import { runCartWallConversion, type ConversionIntent } from "../flows/conversion.js";
import { runStockOutCheckout } from "../flows/stockout.js";
import {
  runAdminFlow,
  runAdminFulfillFlow,
  runAdminRefundFlow,
  runAdminReturnRejectFlow,
  runAdminCancelFlow,
  runAdminSupportFlow,
} from "../flows/admin.js";
import type { PromoConfig } from "../flows/promo.js";
import { runEdgeFlow } from "../flows/edge.js";
import { runCustomerCheckout } from "../personas/customer-llm.js";
import { LIGHT_NOISE } from "../http/noise.js";

function synthAccount(): PoolAccount {
  return { email: newCustomerEmail(), password: DEFAULT_PASSWORD };
}

function poolAccountFor(state: RunState, email: string): PoolAccount | undefined {
  return state.accountPool.find((a) => a.email === email);
}

/** A pooled order owned by a returning (pooled) account — for D1/E. */
function drawReturningOrder(state: RunState, returnableOnly: boolean): PoolOrder | undefined {
  const candidates = state.orderPool.filter(
    (o) =>
      (!returnableOnly || !o.returned) &&
      state.accountPool.some((a) => a.email === o.ownerEmail)
  );
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : undefined;
}

function poolOrder(state: RunState, s: StoreSession, ownerEmail: string, token?: string): void {
  if (!s.lastOrderId) return;
  state.addOrder({
    orderId: s.lastOrderId,
    ownerEmail,
    token,
    regionId: s.regionId,
    items: s.items.map((i) => ({ id: i.id, quantity: 1, variantId: i.variantId })),
  });
}

// --- degrade fallbacks ---
// When a session type can't draw the state it needs (empty pool), it degrades to
// a benign session of the matching role rather than emitting nothing. Admin
// reversal/fulfill types fall back to an admin catalog session; customer
// post-purchase types fall back to a guest browse.

async function adminDegrade(client: MedusaClient, cfg: TrafficConfig): Promise<StepResult[]> {
  return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;
}

async function guestDegrade(client: MedusaClient): Promise<StepResult[]> {
  return (await runGuestShop(client, "browse")).steps;
}

export async function dispatch(
  type: SessionType,
  identity: Identity,
  client: MedusaClient,
  state: RunState,
  cfg: TrafficConfig
): Promise<StepResult[]> {
  // Promo attempt config (Theme 4a): a cart session may apply the seeded valid
  // code (200 discount) or the invalid code (clean 400) per the §4.1 probs.
  const promo: PromoConfig = {
    validCode: state.validPromoCode,
    invalidCode: cfg.invalidPromoCode,
    attemptProb: cfg.eventProbs.promoAttempt,
    invalidProb: cfg.eventProbs.promoInvalid,
  };
  const returning = identity === "returning";

  switch (type) {
    case "bounce": {
      // Returning identity authenticates into a REAL pooled account; if the pool
      // is empty (or this is a guest) it degrades to a guest bounce. Never a
      // synthesized account — its email was never registered, so loginExisting
      // would 401 and the session would mis-mine as a guest.
      const acct = returning ? state.drawAccount() : undefined;
      return acct
        ? (await runReturningFlow(client, acct, "bounce", promo)).steps
        : (await runGuestShop(client, "bounce")).steps;
    }

    case "browse": {
      const acct = returning ? state.drawAccount() : undefined;
      return acct
        ? (await runReturningFlow(client, acct, "browse", promo)).steps
        : (await runGuestShop(client, "browse")).steps;
    }

    case "cartAbandon": {
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      return (await runReturningFlow(client, acct, "cartAbandon", promo)).steps;
    }

    case "checkoutAbandon": {
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      return (await runReturningFlow(client, acct, "checkoutAbandon", promo)).steps;
    }

    case "returningCheckout": {
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      const s = await runReturningFlow(client, acct, "buy", promo);
      poolOrder(state, s, acct.email, acct.token);
      return s.steps;
    }

    case "newCheckout": {
      // HOLDOUT — register→login→checkout, LLM-varied (personas/), never scripted.
      const { session } = await runCustomerCheckout(client, cfg);
      if (session.email) poolOrder(state, session, session.email, session.token);
      return session.steps;
    }

    case "directLanding": {
      // Weighted toward bounce/browse since most share-link clicks don't convert.
      const landingIntents: DirectIntent[] = ["bounce", "bounce", "browse", "browse", "cartAbandon", "buy"];
      let landingIntent = landingIntents[Math.floor(Math.random() * landingIntents.length)];
      // Cart-bearing intents require a customer JWT; browse/bounce honour the split.
      const cartBearing = landingIntent === "cartAbandon" || landingIntent === "buy";
      const acct = (cartBearing || returning) ? state.drawAccount() ?? null : null;
      // No registered account to authenticate with -> drop to a browse so we keep
      // the view_product-first share-link signal instead of an unauth cart cascade.
      if (cartBearing && !acct) landingIntent = "browse";
      const s = await runDirectLandingFlow(client, acct, landingIntent);
      if (landingIntent === "buy" && s.email) poolOrder(state, s, s.email, s.token);
      return s.steps;
    }

    case "comparisonBrowse": {
      const acct = returning ? state.drawAccount() ?? null : null;
      return (await runComparisonBrowseFlow(client, acct)).steps;
    }

    case "categoryBrowse": {
      // Read-only category-led discovery. Returning identity signs into a pooled
      // account; guests browse with no token (identity per IDENTITY_SPLIT 80/20).
      const acct = returning ? state.drawAccount() ?? null : null;
      return (await runCategoryBrowse(client, acct)).steps;
    }

    case "multiItemCheckout": {
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      const multiIntent = chance(0.35) ? "cartAbandon" : "buy";
      const s = await runMultiItemFlow(client, acct, multiIntent, promo);
      if (multiIntent === "buy" && s.email) poolOrder(state, s, s.email, s.token);
      return s.steps;
    }

    case "cartWallConversion": {
      // Guest clicks cart, the storefront redirects to sign-in, then a REAL
      // pooled account signs in and continues to cart. loginExisting must
      // succeed, so draw a registered pooled account — never a synthesized one.
      // If the pool is empty, degrade to a guest browse (Stage 0 always seeds the
      // pool, so this is a safety net).
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      const r = Math.random();
      const intent: ConversionIntent =
        r < 0.55 ? "convertBuy" : r < 0.85 ? "convertAbandon" : "wallBounce";
      const s = await runCartWallConversion(client, acct, intent);
      if (intent === "convertBuy") poolOrder(state, s, acct.email, acct.token);
      return s.steps;
    }

    case "stockOutCheckout": {
      // Returning customer hits the insufficient-inventory 400 on a dedicated
      // limited-stock product (created once in Stage 0). If the pool wasn't
      // seeded (create-product 4xx → lowStockVariantId unset), degrade to a
      // normal returning browse — never hard-fail.
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      if (!state.lowStockVariantId) {
        return (await runReturningFlow(client, acct, "browse", promo)).steps;
      }
      const s = await runStockOutCheckout(client, acct, {
        variantId: state.lowStockVariantId,
        productId: state.lowStockProductId,
        stock: state.lowStockQty ?? 4,
      });
      if (s.lastOrderId) poolOrder(state, s, acct.email, acct.token);
      return s.steps;
    }

    case "cartReviseAbandon": {
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      return (await runReturningFlow(client, acct, "reviseAbandon", promo)).steps;
    }

    case "profileMgmt": {
      const acct = state.drawAccount();
      if (!acct) return guestDegrade(client);
      return (await runProfileMgmtFlow(client, acct)).steps;
    }

    case "adminCatalog":
      return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;

    case "edge":
      return runEdgeFlow(client);

    case "orderStatus": {
      const order = drawReturningOrder(state, false);
      if (!order) return guestDegrade(client);
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      return (
        await runOrderStatusFlow(client, acct, order, cfg.eventProbs.reorderDuringStatus)
      ).steps;
    }

    case "repeatOrderCheck": {
      const order = drawReturningOrder(state, false);
      if (!order) return guestDegrade(client);
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      return (await runRepeatOrderStatusFlow(client, acct, order)).steps;
    }

    case "returns": {
      // Customer return INQUIRY (read-only): the storefront has no customer
      // return endpoint, so the customer only views an order they received
      // (fulfilled). Flagging it hands settlement to an admin refund session
      // (F3) on the same order_id — the cross-role touch.
      const order = state.drawFulfilledOwnedOrder();
      if (!order) return (await runGuestShop(client, "browse")).steps; // degrade
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      state.markReturnRequested(order.orderId);
      return (await runReturnInquiryFlow(client, acct, order)).steps;
    }

    case "adminFulfill": {
      // Stage 2a: fulfill a pooled order so it becomes returnable in F3.
      const order = state.drawForFulfill();
      if (!order) {
        return adminDegrade(client, cfg);
      }
      const { session, fulfilled } = await runAdminFulfillFlow(
        client,
        cfg.adminEmail,
        cfg.adminPassword,
        order.orderId
      );
      if (fulfilled) state.markFulfilled(order.orderId);
      return session.steps;
    }

    case "adminRefund": {
      // Stage 2b: full return+refund lifecycle on a FULFILLED order, preferring
      // one a customer inquired about (E) so it links cross-role on order_id.
      // drawReturnable() claims the order synchronously, so concurrent sessions
      // never open a return on the same order_id.
      const order = state.drawReturnable();
      if (!order) {
        return adminDegrade(client, cfg);
      }
      const { session, returnId, filed, refunded } = await runAdminRefundFlow(
        client,
        cfg.adminEmail,
        cfg.adminPassword,
        order.orderId
      );
      if (filed) {
        state.addReturn({
          orderId: order.orderId,
          returnId: returnId ?? "unknown",
          ownerEmail: order.ownerEmail,
        });
      }
      if (refunded) {
        state.markRefunded(order.orderId);
      }
      return session.steps;
    }

    case "adminReturnReject": {
      // Stage 2b (Theme 4c): file then REJECT a return on a FULFILLED order,
      // preferring one a customer inquired about so it links cross-role on
      // order_id. drawRejectable() claims the order synchronously, so no order
      // gets both a refund (F3) and a rejection. If no fulfilled order is
      // available, degrade to a normal admin catalog session — mirroring F3's
      // empty-pool fallback (the Stage-2 empty-ORDER-pool hard-fail in run.ts
      // still guards the whole wave per CLAUDE.md hard constraint #3).
      const order = state.drawRejectable();
      if (!order) {
        return adminDegrade(client, cfg);
      }
      const { session, returnId, filed, rejected } = await runAdminReturnRejectFlow(
        client,
        cfg.adminEmail,
        cfg.adminPassword,
        order.orderId
      );
      if (filed) {
        state.addReturn({
          orderId: order.orderId,
          returnId: returnId ?? "unknown",
          ownerEmail: order.ownerEmail,
        });
      }
      if (rejected) {
        state.markReturnRejected(order.orderId);
      }
      return session.steps;
    }

    case "adminCancel": {
      // Stage 2b: cancel an UNFULFILLED order (reversal before shipping).
      // drawCancelable() claims the order synchronously.
      const order = state.drawCancelable();
      if (!order) {
        return adminDegrade(client, cfg);
      }
      const { session, canceled } = await runAdminCancelFlow(
        client,
        cfg.adminEmail,
        cfg.adminPassword,
        order.orderId
      );
      if (canceled) state.markCanceled(order.orderId);
      return session.steps;
    }

    case "adminSupport": {
      const query = state.drawAccount()?.email ?? "behavior";
      return (await runAdminSupportFlow(client, cfg.adminEmail, cfg.adminPassword, query)).steps;
    }
  }
}
