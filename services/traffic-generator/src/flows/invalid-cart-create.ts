import { StoreSession } from "../api/store-session.js";
import type { MedusaClient } from "../http/client.js";
import type { PoolAccount } from "../orchestration/state.js";

/**
 * Negative probe flow (false-red demo). A returning customer signs in, then
 * creates a cart that carries an invalid order-level promo code -> 400. Region
 * read and login succeed first, so this 400 is the FIRST error of the session and
 * the behavior engine mines a clean failure flow keyed on `POST /store/carts 400`
 * (shape: `[GET /store/regions, POST /auth/customer/emailpass, POST /store/carts]`).
 *
 * Why this is the canonical "value-based failure with no template" gap:
 *   - `POST /store/carts` is NOT in the script-generator's negativeInputBody
 *     allowlist (only `/store/carts/{id}` and `/store/carts/{id}/line-items` are).
 *   - the bad value lives on the OPTIONAL `promo_codes` field.
 * So structural synth (edgeOmitOnFailure) drops `promo_codes`, emits `{ region_id }`,
 * the live cart create returns 200, and the mined `.toBe(400)` assertion FAILS.
 * The generated spec goes red while the SUT is behaving correctly — a false red.
 */
export async function runInvalidCartCreate(
  client: MedusaClient,
  account: PoolAccount,
  invalidCode: string
): Promise<StoreSession> {
  const session = new StoreSession(client);

  await session.loadRegions();
  await session.loginExisting(account.email, account.password);
  if (session.token) account.token = session.token;
  if (!session.token) {
    return session;
  }

  await session.createCartWithInvalidPromo(invalidCode);
  return session;
}
