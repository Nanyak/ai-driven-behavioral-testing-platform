import { GitCompare, ShoppingCart, X } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";
import { productPath } from "../routing";
import type { Product } from "../types/storefront";
import { formatMoney, getVariantPrice } from "../utils/money";

type ComparePageProps = {
  onNavigate: (path: string) => void;
};

export function ComparePage({ onNavigate }: ComparePageProps) {
  const { addVariantToCart, compareProductIds, isBusy, products, toggleCompare } = useStorefront();
  const comparedProducts = compareProductIds
    .map((productId) => products.find((product) => product.id === productId))
    .filter((product): product is Product => Boolean(product));

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Compare</p>
        <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">Product comparison</h1>
        <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
          Compare up to four products by price, variants, availability, and collection before adding to cart.
        </p>
      </div>

      {comparedProducts.length > 0 ? (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {comparedProducts.map((product) => {
            const firstVariant = product.variants?.[0];
            const price = getVariantPrice(firstVariant);
            const remaining = firstVariant?.inventory_quantity ?? 0;
            const tracksInventory = firstVariant?.manage_inventory !== false;
            const isOutOfStock = tracksInventory && remaining <= 0;

            return (
              <Card key={product.id} className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
                <CardContent className="grid gap-4 p-4">
                  <div className="aspect-[4/3] overflow-hidden rounded-lg bg-gradient-to-br from-lime-100 to-sky-100">
                    {product.thumbnail ? <img className="h-full w-full object-cover" src={product.thumbnail} alt="" /> : null}
                  </div>
                  <div className="grid gap-1">
                    <AppLink className="font-black leading-snug text-emerald-950 hover:text-emerald-700" to={productPath(product.id)} onNavigate={onNavigate}>
                      {product.title}
                    </AppLink>
                    <span className="text-sm font-bold text-emerald-700">{product.collection?.title || product.subtitle || "Store catalog"}</span>
                  </div>
                  <dl className="grid gap-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="font-bold text-emerald-700">Price</dt>
                      <dd className="font-black text-emerald-950">{formatMoney(price?.amount, price?.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="font-bold text-emerald-700">Variants</dt>
                      <dd className="font-black text-emerald-950">{product.variants?.length ?? 0}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="font-bold text-emerald-700">Stock</dt>
                      <dd className="font-black text-emerald-950">{tracksInventory ? remaining : "In stock"}</dd>
                    </div>
                  </dl>
                  <div className="grid gap-2">
                    <Button type="button" className="h-10 bg-orange-500 font-black text-white hover:bg-orange-600" disabled={isBusy || !firstVariant?.id || isOutOfStock} onClick={() => firstVariant?.id && addVariantToCart(firstVariant.id)}>
                      <ShoppingCart className="size-4" aria-hidden="true" />
                      <span>{isOutOfStock ? "Sold out" : "Add to cart"}</span>
                    </Button>
                    <Button type="button" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" onClick={() => toggleCompare(product.id)}>
                      <X className="size-4" aria-hidden="true" />
                      <span>Remove</span>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      ) : (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid min-h-72 justify-items-start gap-4 p-6">
            <GitCompare className="size-11 text-emerald-600" aria-hidden="true" />
            <h2 className="text-3xl font-black tracking-tight text-emerald-950">No products selected</h2>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              Use the compare icon on product cards to build a side-by-side shortlist.
            </p>
            <AppLink className={buttonVariants({ className: "h-10 bg-orange-500 px-5 font-black text-white hover:bg-orange-600" })} to="/" onNavigate={onNavigate}>
              Browse products
            </AppLink>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
