import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

// One-off data fix: early seed data stored EUR and shipping prices in MINOR
// units (cents, a Medusa v1 habit) while Medusa v2 treats `price.amount` as a
// DECIMAL major unit. That made the admin (v2-native) show 100x the storefront,
// which was dividing by 100 to compensate. Once the storefront stops dividing
// and the seed uses decimals, the already-seeded DB still holds the inflated
// values — this script normalizes them.
//
// Every legitimate decimal price in this catalog is < 1000 and every cents-style
// value is >= 1000, so the threshold cleanly separates the two. Idempotent: on a
// freshly (correctly) seeded DB there are no amounts >= 1000, so it is a no-op.
export default async function normalize_price_units({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);

  const result = await knex("price")
    .where("amount", ">=", 1000)
    .update({ amount: knex.raw("amount / 100") });

  logger.info(`normalize-price-units: divided ${result} price row(s) by 100 (cents -> decimal).`);
}
