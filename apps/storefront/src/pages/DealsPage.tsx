import { BadgePercent, Clock } from "lucide-react";
import { ProductGrid } from "../components/ProductGrid";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";
import { getDealScore, getProductDeal } from "../utils/marketplace";

type DealsPageProps = {
  onNavigate: (path: string) => void;
};

export function DealsPage({ onNavigate }: DealsPageProps) {
  const {
    addVariantToCart,
    isBusy,
    isWishlisted,
    loadProducts,
    products,
    toggleWishlist,
  } = useStorefront();
  const dealProducts = [...products]
    .sort((left, right) => getDealScore(right) - getDealScore(left))
    .slice(0, 12);
  const bestDiscount = dealProducts.reduce((best, product) => Math.max(best, getProductDeal(product).discountPercent), 0);

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <section className="grid gap-4 rounded-lg border border-orange-100 bg-orange-50 p-6 shadow-xl shadow-orange-950/5 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="grid gap-3">
          <span className="flex size-12 items-center justify-center rounded-lg bg-orange-500 text-white">
            <BadgePercent className="size-7" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-black uppercase tracking-normal text-orange-700">Deals</p>
            <h1 className="mt-1 text-4xl font-black tracking-tight text-orange-950 md:text-6xl">Voucher picks</h1>
            <p className="mt-2 max-w-2xl font-semibold leading-7 text-orange-900/70">
              Browse discounted, low-stock, and checkout-ready products from the current catalog.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:min-w-80">
          <Card className="border-orange-200 bg-white py-0">
            <CardContent className="grid gap-2 p-4">
              <span className="text-sm font-black uppercase text-orange-700">Best discount</span>
              <strong className="text-3xl font-black text-orange-950">{bestDiscount}%</strong>
            </CardContent>
          </Card>
          <Card className="border-orange-200 bg-white py-0">
            <CardContent className="grid gap-2 p-4">
              <span className="flex items-center gap-1 text-sm font-black uppercase text-orange-700">
                <Clock className="size-4" aria-hidden="true" />
                Live picks
              </span>
              <strong className="text-3xl font-black text-orange-950">{dealProducts.length}</strong>
            </CardContent>
          </Card>
        </div>
      </section>

      <ProductGrid
        products={dealProducts}
        isBusy={isBusy}
        isWishlisted={isWishlisted}
        onAddVariantToCart={addVariantToCart}
        onNavigate={onNavigate}
        onRefresh={loadProducts}
        onToggleWishlist={toggleWishlist}
        showDeal
      />
    </main>
  );
}
