import { useEffect } from "react";
import { AppLink } from "../components/AppLink";
import { ProductDetail } from "../components/ProductDetail";
import { ProductGrid } from "../components/ProductGrid";
import { buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";
import { getRecommendedProducts } from "../utils/marketplace";

type ProductPageProps = {
  productId: string;
  onNavigate: (path: string) => void;
};

export function ProductPage({ productId, onNavigate }: ProductPageProps) {
  const {
    addVariantToCart,
    customer,
    getProduct,
    getProductReviews,
    getSelectedVariant,
    hasPurchasedProduct,
    isWishlisted,
    isBusy,
    loadProducts,
    products,
    rememberViewedProduct,
    selectedVariantId,
    setSelectedVariantId,
    submitReview,
    toggleWishlist,
  } = useStorefront();
  const product = getProduct(productId);
  const selectedVariant = getSelectedVariant(product);
  const recommendedProducts = getRecommendedProducts(product, products);

  useEffect(() => {
    rememberViewedProduct(productId);
  }, [productId]);

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-10 md:px-6">
      {product ? (
        <ProductDetail
          product={product}
          selectedVariant={selectedVariant}
          selectedVariantId={selectedVariant?.id || selectedVariantId}
          isBusy={isBusy}
          isWishlisted={isWishlisted(product.id)}
          customer={customer}
          hasPurchased={hasPurchasedProduct(product.id)}
          reviews={getProductReviews(product.id)}
          onSelectVariant={setSelectedVariantId}
          onAddToCart={() => selectedVariant?.id && addVariantToCart(selectedVariant.id)}
          onSubmitReview={(review) => submitReview({ ...review, product_id: product.id })}
          onToggleWishlist={() => toggleWishlist(product.id)}
          onNavigate={onNavigate}
        />
      ) : (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid min-h-72 justify-items-start gap-4 p-6">
            <h1 className="text-4xl font-black tracking-tight text-emerald-950">Product not found</h1>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              The catalog may still be loading, or this item is no longer available.
            </p>
            <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to="/" onNavigate={onNavigate}>
              Back to shop
            </AppLink>
          </CardContent>
        </Card>
      )}
      {recommendedProducts.length > 0 ? (
        <ProductGrid
          products={recommendedProducts}
          isBusy={isBusy}
          isWishlisted={isWishlisted}
          onAddVariantToCart={addVariantToCart}
          onRefresh={loadProducts}
          onNavigate={onNavigate}
          onToggleWishlist={toggleWishlist}
          showDeal
        />
      ) : null}
    </main>
  );
}
