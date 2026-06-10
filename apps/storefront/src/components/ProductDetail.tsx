import { Package, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Label } from "./ui/label";
import type { Product, Variant } from "../types/storefront";
import { formatMoney, getVariantPrice } from "../utils/money";

type ProductDetailProps = {
  product?: Product;
  selectedVariant?: Variant;
  selectedVariantId: string;
  isBusy: boolean;
  onSelectVariant: (variantId: string) => void;
  onAddToCart: () => void;
};

export function ProductDetail({
  product,
  selectedVariant,
  selectedVariantId,
  isBusy,
  onSelectVariant,
  onAddToCart,
}: ProductDetailProps) {
  const selectedPrice = getVariantPrice(selectedVariant);

  if (!product) {
    return (
      <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5" aria-label="Product detail">
        <CardContent className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-emerald-700">
          <Package className="size-12" aria-hidden="true" />
          <p className="font-bold">Select a product to see details.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="grid overflow-hidden rounded-lg border border-emerald-100 bg-white shadow-xl shadow-emerald-950/5 lg:grid-cols-[minmax(260px,44%)_minmax(0,1fr)]" aria-label={`${product.title} details`}>
      <div className="flex min-h-80 items-center justify-center overflow-hidden bg-gradient-to-br from-emerald-100 to-orange-100 text-emerald-600 lg:min-h-[540px]">
        {product.thumbnail ? <img className="h-full w-full object-cover" src={product.thumbnail} alt={product.title} /> : <Package className="size-16" aria-hidden="true" />}
      </div>
      <div className="flex flex-col justify-center gap-5 p-6 lg:p-9">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">{product.handle || "Seeded product"}</p>
        <h2 className="text-4xl font-black leading-none tracking-tight text-emerald-950 lg:text-6xl">{product.title}</h2>
        <p className="max-w-prose text-base font-semibold leading-8 text-emerald-900/75">
          {product.description || product.subtitle || "Ready for cart and checkout testing."}
        </p>
        <div className="grid gap-2">
          <Label htmlFor="variant-select" className="font-black text-emerald-950">
            Variant
          </Label>
          <select
            id="variant-select"
            className="h-11 rounded-lg border border-emerald-200 bg-white px-3 font-bold text-emerald-950 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15"
            value={selectedVariantId}
            onChange={(event) => onSelectVariant(event.target.value)}
          >
            {(product.variants ?? []).map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.title}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <strong className="text-3xl font-black text-emerald-950">{formatMoney(selectedPrice?.amount, selectedPrice?.currency)}</strong>
          <Button type="button" className="h-11 bg-orange-500 px-5 font-black text-white hover:bg-orange-600" onClick={onAddToCart} disabled={isBusy || !selectedVariant}>
            <Plus className="size-4" aria-hidden="true" />
            <span>Add to cart</span>
          </Button>
        </div>
      </div>
    </section>
  );
}
