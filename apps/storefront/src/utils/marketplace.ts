import type { Product } from "../types/storefront";
import { getVariantPrice } from "./money";

export function getProductCategory(product: Product) {
  return product.collection?.title || product.tags?.[0]?.value || product.subtitle || "All products";
}

export function getProductSeller(product: Product) {
  return product.collection?.title || product.tags?.[0]?.value || "Behavior Market";
}

export function getRecommendedProducts(product: Product | undefined, products: Product[], limit = 6) {
  if (!product) {
    return products.slice(0, limit);
  }

  const category = getProductCategory(product);
  const seller = getProductSeller(product);

  return products
    .filter((candidate) => candidate.id !== product.id)
    .sort((left, right) => {
      const leftScore = Number(getProductCategory(left) === category) + Number(getProductSeller(left) === seller);
      const rightScore = Number(getProductCategory(right) === category) + Number(getProductSeller(right) === seller);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

export function getProductDeal(product: Product) {
  const price = getVariantPrice(product.variants?.[0]);
  const originalAmount = product.variants?.[0]?.calculated_price?.original_amount;

  if (!price?.amount || !originalAmount || originalAmount <= price.amount) {
    return {
      discountPercent: 0,
      originalAmount,
    };
  }

  return {
    discountPercent: Math.round(((originalAmount - price.amount) / originalAmount) * 100),
    originalAmount,
  };
}

export function getDealScore(product: Product) {
  const { discountPercent } = getProductDeal(product);
  const stock = product.variants?.[0]?.inventory_quantity ?? 0;
  return discountPercent * 10 + Math.min(stock, 10);
}
