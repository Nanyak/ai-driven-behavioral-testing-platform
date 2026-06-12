import { PackageSearch } from "lucide-react";
import { ProductGrid } from "../components/ProductGrid";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";

type CollectionPageProps = {
  collectionName: string;
  onNavigate: (path: string) => void;
};

function productCollectionName(product: { collection?: { title?: string }; tags?: Array<{ value?: string }>; subtitle?: string }) {
  return product.collection?.title || product.tags?.[0]?.value || product.subtitle || "All products";
}

export function CollectionPage({ collectionName, onNavigate }: CollectionPageProps) {
  const {
    addVariantToCart,
    isBusy,
    isWishlisted,
    loadProducts,
    products,
    toggleWishlist,
  } = useStorefront();
  const normalizedCollectionName = collectionName.toLowerCase();
  const collectionProducts = products.filter((product) => productCollectionName(product).toLowerCase() === normalizedCollectionName);

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Collection</p>
        <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">{collectionName}</h1>
        <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
          Browse a focused shelf with quick add, saved items, and comparison tools.
        </p>
      </div>

      {collectionProducts.length > 0 ? (
        <ProductGrid
          products={collectionProducts}
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
            <PackageSearch className="size-11 text-emerald-600" aria-hidden="true" />
            <h2 className="text-3xl font-black tracking-tight text-emerald-950">No products in this collection</h2>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              Refresh the catalog or choose another collection from the shop page.
            </p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
