import { Store, Star } from "lucide-react";
import { ProductGrid } from "../components/ProductGrid";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";
import { getProductSeller } from "../utils/marketplace";

type SellerPageProps = {
  sellerName: string;
  onNavigate: (path: string) => void;
};

export function SellerPage({ sellerName, onNavigate }: SellerPageProps) {
  const {
    addVariantToCart,
    getProductReviews,
    isBusy,
    isCompared,
    isWishlisted,
    loadProducts,
    products,
    toggleCompare,
    toggleWishlist,
  } = useStorefront();
  const sellerProducts = products.filter((product) => getProductSeller(product).toLowerCase() === sellerName.toLowerCase());
  const reviewCount = sellerProducts.reduce((total, product) => total + getProductReviews(product.id).length, 0);
  const productCount = sellerProducts.length;

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <section className="grid gap-4 rounded-lg border border-emerald-100 bg-white p-6 shadow-xl shadow-emerald-950/5 md:grid-cols-[1fr_auto] md:items-center">
        <div className="grid gap-3">
          <span className="flex size-12 items-center justify-center rounded-lg bg-emerald-700 text-white">
            <Store className="size-7" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Seller storefront</p>
            <h1 className="mt-1 text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">{sellerName}</h1>
            <p className="mt-2 max-w-2xl font-semibold leading-7 text-emerald-900/70">
              Shop this seller's products with quick add, saved items, comparison, and checkout-ready inventory.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 md:min-w-72">
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-4">
            <span className="text-sm font-black uppercase text-emerald-700">Products</span>
            <strong className="mt-1 block text-3xl font-black text-emerald-950">{productCount}</strong>
          </div>
          <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
            <span className="flex items-center gap-1 text-sm font-black uppercase text-amber-700">
              <Star className="size-4 fill-current" aria-hidden="true" />
              Reviews
            </span>
            <strong className="mt-1 block text-3xl font-black text-amber-900">{reviewCount}</strong>
          </div>
        </div>
      </section>

      {sellerProducts.length > 0 ? (
        <ProductGrid
          products={sellerProducts}
          isBusy={isBusy}
          isCompared={isCompared}
          isWishlisted={isWishlisted}
          onAddVariantToCart={addVariantToCart}
          onNavigate={onNavigate}
          onRefresh={loadProducts}
          onToggleCompare={toggleCompare}
          onToggleWishlist={toggleWishlist}
        />
      ) : (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid min-h-72 justify-items-start gap-4 p-6">
            <Store className="size-11 text-emerald-600" aria-hidden="true" />
            <h2 className="text-3xl font-black tracking-tight text-emerald-950">Seller products unavailable</h2>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              Refresh the catalog or browse another seller from product cards.
            </p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
