import type { MedusaClient } from "./client.js";
import type { TrafficConfig } from "./config.js";
import { DEFAULT_PASSWORD, StoreSession } from "./api/store-session.js";
import type { StepResult } from "./api/step.js";
import { RunState, type PoolAccount, type PoolOrder } from "./state.js";
import type { SessionType, Identity } from "./taxonomy.js";
import { chance } from "./util/random.js";
import { newCustomerEmail } from "./ids.js";
import { runGuestShop } from "./flows/guest.js";
import { runReturningFlow } from "./flows/returning.js";
import { runOrderStatusFlow, runRepeatOrderStatusFlow, runProfileMgmtFlow } from "./flows/account.js";
import { runReturnFlow } from "./flows/returns.js";
import { runDirectLandingFlow, type DirectIntent } from "./flows/direct-landing.js";
import { runComparisonBrowseFlow } from "./flows/comparison-browse.js";
import { runMultiItemFlow } from "./flows/multi-item.js";
import {
  runAdminFlow,
  runAdminFulfillFlow,
  runAdminRefundFlow,
  runAdminSupportFlow,
} from "./flows/admin.js";
import { runEdgeFlow } from "./flows/edge.js";
import { runCustomerCheckout } from "./personas/customer-llm.js";
import { LIGHT_NOISE } from "./noise.js";

// --- pool helpers ---

function synthAccount(): PoolAccount {
  return { email: newCustomerEmail(), password: DEFAULT_PASSWORD };
}

function drawOrSynth(state: RunState): PoolAccount {
  return state.drawAccount() ?? synthAccount();
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

// --- dispatch: one session of the given type/identity ---

export async function dispatch(
  type: SessionType,
  identity: Identity,
  client: MedusaClient,
  state: RunState,
  cfg: TrafficConfig
): Promise<StepResult[]> {
  const promo = state.validPromoCode;
  const returning = identity === "returning";

  switch (type) {
    case "bounce":
      return returning
        ? (await runReturningFlow(client, drawOrSynth(state), "bounce", promo)).steps
        : (await runGuestShop(client, "bounce")).steps;

    case "browse":
      return returning
        ? (await runReturningFlow(client, drawOrSynth(state), "browse", promo)).steps
        : (await runGuestShop(client, "browse")).steps;

    case "cartAbandon":
      return (await runReturningFlow(client, drawOrSynth(state), "cartAbandon", promo)).steps;

    case "checkoutAbandon":
      return (await runReturningFlow(client, drawOrSynth(state), "checkoutAbandon", promo)).steps;

    case "returningCheckout": {
      const acct = drawOrSynth(state);
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
      const landingIntent = landingIntents[Math.floor(Math.random() * landingIntents.length)];
      // Cart-bearing intents require auth; browse/bounce intents honour the identity split.
      const cartBearing = landingIntent === "cartAbandon" || landingIntent === "buy";
      const acct = (cartBearing || returning) ? drawOrSynth(state) : null;
      const s = await runDirectLandingFlow(client, acct, landingIntent, promo);
      if (landingIntent === "buy" && s.email) poolOrder(state, s, s.email, s.token);
      return s.steps;
    }

    case "comparisonBrowse": {
      const acct = returning ? drawOrSynth(state) : null;
      return (await runComparisonBrowseFlow(client, acct)).steps;
    }

    case "multiItemCheckout": {
      const acct = drawOrSynth(state);
      const multiIntent = chance(0.35) ? "cartAbandon" : "buy";
      const s = await runMultiItemFlow(client, acct, multiIntent, promo);
      if (multiIntent === "buy" && s.email) poolOrder(state, s, s.email, s.token);
      return s.steps;
    }

    case "profileMgmt":
      return (await runProfileMgmtFlow(client, drawOrSynth(state))).steps;

    case "adminCatalog":
      return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;

    case "edge":
      return runEdgeFlow(client);

    case "orderStatus": {
      const order = drawReturningOrder(state, false);
      if (!order) return (await runGuestShop(client, "browse")).steps; // degrade
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      return (
        await runOrderStatusFlow(client, acct, order, cfg.eventProbs.reorderDuringStatus)
      ).steps;
    }

    case "repeatOrderCheck": {
      const order = drawReturningOrder(state, false);
      if (!order) return (await runGuestShop(client, "browse")).steps; // degrade
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      return (await runRepeatOrderStatusFlow(client, acct, order)).steps;
    }

    case "returns": {
      const order = drawReturningOrder(state, true);
      if (!order) return (await runGuestShop(client, "browse")).steps; // degrade
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      const { session, returnId, filed } = await runReturnFlow(client, acct, order);
      if (filed) {
        state.addReturn({ orderId: order.orderId, returnId: returnId ?? "unknown", ownerEmail: order.ownerEmail });
      }
      return session.steps;
    }

    case "adminFulfill": {
      const order = state.drawOrder();
      if (!order) {
        return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;
      }
      return (await runAdminFulfillFlow(client, cfg.adminEmail, cfg.adminPassword, order.orderId)).steps;
    }

    case "adminRefund": {
      const pending = state.drawReturn();
      const orderId = pending?.orderId ?? state.drawOrder()?.orderId;
      if (!orderId) {
        return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;
      }
      const session = await runAdminRefundFlow(
        client,
        cfg.adminEmail,
        cfg.adminPassword,
        orderId,
        pending?.returnId && pending.returnId !== "unknown" ? pending.returnId : undefined
      );
      if (session.steps.some((s) => s.action === "admin_refund" && s.ok)) {
        state.markRefunded(orderId);
      }
      return session.steps;
    }

    case "adminSupport": {
      const query = state.drawAccount()?.email ?? "behavior";
      return (await runAdminSupportFlow(client, cfg.adminEmail, cfg.adminPassword, query)).steps;
    }
  }
}
