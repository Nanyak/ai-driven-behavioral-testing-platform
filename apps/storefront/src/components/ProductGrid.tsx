import { ArrowRight, GitCompare, Heart, PackageSearch, RefreshCw, ShoppingCart } from "lucide-react";
import { AppLink } from "./AppLink";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { productPath, sellerPath } from "../routing";
import type { Product } from "../types/storefront";
import { getProductSeller } from "../utils/marketplace";
import { formatMoney, getVariantPrice } from "../utils/money";

type ProductGridProps = {
  products: Product[];
  isBusy: boolean;
  isCompared: (productId: string) => boolean;
  isWishlisted: (productId: string) => boolean;
  onAddVariantToCart: (variantId: string) => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onToggleCompare: (productId: string) => void;
  onToggleWishlist: (productId: string) => void;
};

export function ProductGrid({ products, isBusy, isCompared, isWishlisted, onAddVariantToCart, onNavigate, onRefresh, onToggleCompare, onToggleWishlist }: ProductGridProps) {
  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-xl shadow-slate-900/5" id="catalog" aria-labelledby="catalog-title">
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-emerald-600">Catalog</p>
          <h2 id="catalog-title" className="mt-1 text-2xl font-black tracking-tight text-slate-900">
            Featured products
          </h2>
        </div>
        <Button type="button" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" onClick={onRefresh} disabled={isBusy}>
          <RefreshCw className="size-4" aria-hidden="true" />
          <span>Refresh</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {products.length === 0 && isBusy ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="animate-pulse overflow-hidden rounded-2xl border border-slate-100 bg-white">
              <div className="aspect-[4/3] bg-slate-100" />
              <div className="grid gap-4 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="grid flex-1 gap-2">
                    <div className="h-5 w-4/5 rounded-lg bg-slate-100" />
                    <div className="h-4 w-2/3 rounded-lg bg-slate-100" />
                  </div>
                  <div className="flex gap-2">
                    <div className="size-9 rounded-lg bg-slate-100" />
                    <div className="size-9 rounded-lg bg-slate-100" />
                  </div>
                </div>
                <div className="h-4 w-1/3 rounded-lg bg-slate-100" />
                <div className="flex items-center justify-between gap-3">
                  <div className="grid gap-2">
                    <div className="h-7 w-24 rounded-lg bg-slate-100" />
                    <div className="h-6 w-16 rounded-lg bg-slate-100" />
                  </div>
                  <div className="h-10 w-24 rounded-lg bg-slate-100" />
                </div>
              </div>
            </div>
          ))
        ) : products.length > 0 ? (
          products.map((product) => {
            const firstVariant = product.variants?.[0];
            const price = getVariantPrice(firstVariant);
            const tracksInventory = firstVariant?.manage_inventory !== false;
            const remaining = firstVariant?.inventory_quantity ?? 0;
            const isOutOfStock = tracksInventory && remaining <= 0;
            const compared = isCompared(product.id);
            const saved = isWishlisted(product.id);
            const seller = getProductSeller(product);

            return (
              <Card key={product.id} className="group h-full gap-0 overflow-hidden rounded-2xl border-slate-100 py-0 transition-all duration-200 hover:border-emerald-400 hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-slate-900/10">
                <AppLink className="block cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-400/40" to={productPath(product.id)} onNavigate={onNavigate}>
                  <div className="aspect-[4/3] overflow-hidden bg-gradient-to-br from-slate-100 to-emerald-50 text-emerald-500">
                    {product.thumbnail ? (
                      <img className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.035]" src={product.thumbnail} alt="" />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <PackageSearch className="size-11" aria-hidden="true" />
                      </div>
                    )}
                  </div>
                </AppLink>
                <CardContent className="grid gap-4 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <AppLink className="grid min-w-0 gap-1 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-400/40" to={productPath(product.id)} onNavigate={onNavigate}>
                      <span className="block text-base font-black leading-snug text-slate-900">{product.title}</span>
                      <span className="block text-sm font-bold text-emerald-700">
                        {product.variants?.length ?? 0} variants - {tracksInventory ? `${remaining} remaining` : "in stock"}
                      </span>
                    </AppLink>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className={`size-9 border-emerald-200 p-0 hover:bg-emerald-50 ${compared ? "bg-sky-50 text-sky-700" : "text-emerald-800"}`}
                        onClick={() => onToggleCompare(product.id)}
                        aria-label={compared ? `Remove ${product.title} from comparison` : `Compare ${product.title}`}
                      >
                        <GitCompare className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className={`size-9 border-emerald-200 p-0 hover:bg-emerald-50 ${saved ? "bg-red-50 text-red-600" : "text-emerald-800"}`}
                        onClick={() => onToggleWishlist(product.id)}
                        aria-label={saved ? `Remove ${product.title} from wishlist` : `Save ${product.title} to wishlist`}
                      >
                        <Heart className={`size-4 ${saved ? "fill-current" : ""}`} aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  <AppLink className="w-fit text-sm font-black text-sky-700 hover:text-sky-900" to={sellerPath(seller)} onNavigate={onNavigate}>
                    Sold by {seller}
                  </AppLink>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <strong className="text-lg font-black text-slate-900">{formatMoney(price?.amount, price?.currency)}</strong>
                      <Badge variant="outline" className="mt-1 h-7 border-emerald-200 bg-emerald-50 font-black text-emerald-700">
                        Details
                        <ArrowRight className="size-3" aria-hidden="true" />
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      className="h-10 bg-orange-500 px-3 font-black text-white hover:bg-orange-600"
                      disabled={isBusy || !firstVariant?.id || isOutOfStock}
                      onClick={() => firstVariant?.id && onAddVariantToCart(firstVariant.id)}
                    >
                      <ShoppingCart className="size-4" aria-hidden="true" />
                      <span>{isOutOfStock ? "Sold out" : "Add"}</span>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <div className="col-span-full flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/80 text-slate-500">
            <PackageSearch className="size-10 text-slate-300" aria-hidden="true" />
            <p className="font-bold">No products match your filters.</p>
          </div>
        )}
      </div>
    </section>
  );
}
