import type { StoreSession } from "../api/store-session.js";
import { chance } from "../util/random.js";

export interface PromoConfig {
  validCode?: string;
  invalidCode?: string;
  attemptProb: number;
  invalidProb: number;
}

/**
 * Both the valid and invalid code paths emit the same `apply_promo` event, so
 * the success/failure split is a status signal for the behavior engine, not a separate
 * endpoint.
 */
export async function maybeApplyPromo(session: StoreSession, promo?: PromoConfig): Promise<void> {
  if (!promo || !chance(promo.attemptProb)) return;
  const useInvalid = !!promo.invalidCode && chance(promo.invalidProb);
  const code = useInvalid ? promo.invalidCode : promo.validCode;
  if (code) await session.applyPromoCode(code);
}
