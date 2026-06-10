import type { Variant } from "../types/storefront";

export function formatMoney(amount?: number, currency = "USD") {
  if (typeof amount !== "number") {
    return "Price pending";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
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
