import type { StoreSession } from "../api/store-session.js";
import { chance } from "../util/random.js";

/**
 * Promo-code config threaded into cart-bearing flows (Theme 4a). Carries both
 * the seeded valid code (applies a discount, 200) and an invalid code (surfaces
 * a clean, countable 400 — "The promotion code ... is invalid") plus the
 * event-level probabilities that decide whether/which code a session tries.
 */
export interface PromoConfig {
  validCode?: string;
  invalidCode?: string;
  /** Probability a cart session attempts any promo at all (plan §4.1). */
  attemptProb: number;
  /** Of attempts, probability the code is the invalid one (negative path). */
  invalidProb: number;
}

/**
 * Apply at most one promo code to the cart per the §4.1 event probabilities. A
 * `promoAttempt`-gated session picks the invalid code with `invalidProb` (→ 400)
 * or the seeded valid code otherwise (→ 200 discount). Both emit the same
 * `apply_promo` event, so the success/failure split is a status signal for
 * Phase 7, not a separate endpoint (Theme 4a).
 */
export async function maybeApplyPromo(session: StoreSession, promo?: PromoConfig): Promise<void> {
  if (!promo || !chance(promo.attemptProb)) return;
  const useInvalid = !!promo.invalidCode && chance(promo.invalidProb);
  const code = useInvalid ? promo.invalidCode : promo.validCode;
  if (code) await session.applyPromoCode(code);
}
