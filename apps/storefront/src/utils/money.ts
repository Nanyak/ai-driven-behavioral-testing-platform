import type { Variant } from "../types/storefront";

export function formatMoney(amount?: number, currency = "USD") {
  if (typeof amount !== "number") {
    return "Price pending";
  }

  // Medusa v2 stores money as decimal major units (e.g. 15 = $15.00), so the
  // amount is formatted as-is — no division by 100 (that was a Medusa v1 habit).
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}

export function getVariantPrice(variant?: Variant) {
  if (!variant) {
    return undefined;
  }

  if (typeof variant.calculated_price?.calculated_amount === "number") {
    return {
      amount: variant.calculated_price.calculated_amount,
      currency: variant.calculated_price.currency_code || "USD",
    };
  }

  const firstPrice = variant.prices?.[0];
  return {
    amount: firstPrice?.amount,
    currency: firstPrice?.currency_code || "USD",
  };
}
