import { ArrowRight, PackageSearch, RefreshCw } from "lucide-react";
import { AppLink } from "./AppLink";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { productPath } from "../routing";
import type { Product } from "../types/storefront";
import { formatMoney, getVariantPrice } from "../utils/money";

type ProductGridProps = {
  products: Product[];
  isBusy: boolean;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
};

export function ProductGrid({ products, isBusy, onNavigate, onRefresh }: ProductGridProps) {
  return (
    <section className="rounded-lg border border-emerald-100 bg-white p-5 shadow-xl shadow-emerald-950/5" id="catalog" aria-labelledby="catalog-title">
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Catalog</p>
          <h2 id="catalog-title" className="mt-1 text-2xl font-black tracking-tight text-emerald-950">
            Featured products
          </h2>
        </div>
        <Button type="button" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" onClick={onRefresh} disabled={isBusy}>
          <RefreshCw className="size-4" aria-hidden="true" />
          <span>Refresh</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {products.length > 0 ? (
          products.map((product) => {
            const firstVariant = product.variants?.[0];
            const price = getVariantPrice(firstVariant);

            return (
              <AppLink
                key={product.id}
                className="group block focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-400/40"
                to={productPath(product.id)}
                onNavigate={onNavigate}
              >
                <Card className="h-full gap-0 overflow-hidden rounded-lg border-emerald-100 py-0 transition-all group-hover:border-emerald-500 group-hover:shadow-xl group-hover:shadow-emerald-950/10">
                  <div className="aspect-[4/3] overflow-hidden bg-gradient-to-br from-emerald-100 to-orange-100 text-emerald-600">
                    {product.thumbnail ? (
                      <img className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.035]" src={product.thumbnail} alt="" />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <PackageSearch className="size-11" aria-hidden="true" />
                      </div>
                    )}
                  </div>
                  <CardContent className="grid gap-4 p-4">
                    <div>
                      <span className="block text-base font-black leading-snug text-emerald-950">{product.title}</span>
                      <span className="mt-1 block text-sm font-bold text-emerald-700">{product.variants?.length ?? 0} variants available</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-lg font-black text-emerald-950">{formatMoney(price?.amount, price?.currency)}</strong>
                      <Badge variant="outline" className="h-8 border-emerald-200 bg-emerald-50 font-black text-emerald-700">
                        Details
                        <ArrowRight className="size-3" aria-hidden="true" />
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </AppLink>
            );
          })
        ) : (
          <div className="col-span-full flex min-h-40 items-center justify-center rounded-lg border border-dashed border-emerald-200 bg-emerald-50/50 font-bold text-emerald-700">
            No products loaded.
          </div>
        )}
      </div>
    </section>
  );
}
