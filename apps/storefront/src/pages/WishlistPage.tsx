import { Heart } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { ProductGrid } from "../components/ProductGrid";
import { buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";

type WishlistPageProps = {
  onNavigate: (path: string) => void;
};

export function WishlistPage({ onNavigate }: WishlistPageProps) {
  const {
    addVariantToCart,
    isBusy,
    isWishlisted,
    loadProducts,
    products,
    toggleWishlist,
    wishlistProductIds,
  } = useStorefront();
  const wishlistProducts = products.filter((product) => wishlistProductIds.includes(product.id));

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Saved</p>
        <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">Wishlist</h1>
        <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
          Keep products close while browsing, then add them to cart when ready.
        </p>
      </div>

      {wishlistProducts.length > 0 ? (
        <ProductGrid
          products={wishlistProducts}
          isBusy={isBusy}
          isWishlisted={isWishlisted}
          onAddVariantToCart={addVariantToCart}
          onNavigate={onNavigate}
          onRefresh={loadProducts}
          onToggleWishlist={toggleWishlist}
          showDeal
        />
      ) : (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid min-h-72 justify-items-start gap-4 p-6">
            <Heart className="size-11 text-emerald-600" aria-hidden="true" />
            <h2 className="text-3xl font-black tracking-tight text-emerald-950">No saved products yet</h2>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              Save products from catalog cards or product detail pages to build a shopping shortlist.
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
