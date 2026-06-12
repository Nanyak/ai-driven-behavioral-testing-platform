import { useMemo, useState } from "react";
import { ArrowDownAZ } from "lucide-react";
import { ProductGrid } from "../components/ProductGrid";
import { StoreHero } from "../components/StoreHero";
import { AppLink } from "../components/AppLink";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useStorefront } from "../context/StorefrontContext";
import { collectionPath, productPath } from "../routing";
import type { Product } from "../types/storefront";
import { getProductCategory } from "../utils/marketplace";
import { formatMoney, getVariantPrice } from "../utils/money";

type HomePageProps = {
  onNavigate: (path: string) => void;
};

export function HomePage({ onNavigate }: HomePageProps) {
  const { addVariantToCart, isBusy, isWishlisted, loadProducts, products, recentlyViewedProductIds, searchQuery, toggleWishlist } = useStorefront();
  const [activeCategory, setActiveCategory] = useState("All");
  const [sortMode, setSortMode] = useState<"featured" | "price-asc" | "price-desc" | "name">("featured");

  const categories = useMemo(() => {
    const nextCategories = new Set(products.map(getProductCategory).filter(Boolean));
    return ["All", ...Array.from(nextCategories).slice(0, 8)];
  }, [products]);

  const visibleProducts = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const filteredProducts = products.filter((product) => {
      const searchable = [
        product.title,
        product.subtitle,
        product.description,
        product.handle,
        product.collection?.title,
        ...(product.tags ?? []).map((tag) => tag.value),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
      const matchesCategory = activeCategory === "All" || getProductCategory(product) === activeCategory;
      return matchesSearch && matchesCategory;
    });

    return [...filteredProducts].sort((left, right) => {
      if (sortMode === "name") {
        return left.title.localeCompare(right.title);
      }

      const leftPrice = getVariantPrice(left.variants?.[0])?.amount ?? 0;
      const rightPrice = getVariantPrice(right.variants?.[0])?.amount ?? 0;

      if (sortMode === "price-asc") {
        return leftPrice - rightPrice;
      }

      if (sortMode === "price-desc") {
        return rightPrice - leftPrice;
      }

      return 0;
    });
  }, [activeCategory, products, searchQuery, sortMode]);
  const recentlyViewedProducts = useMemo(
    () => recentlyViewedProductIds
      .map((productId) => products.find((product) => product.id === productId))
      .filter((product): product is Product => Boolean(product))
      .slice(0, 4),
    [products, recentlyViewedProductIds]
  );

  return (
    <>
      <StoreHero onNavigate={onNavigate} />
      <main className="mx-auto grid max-w-7xl gap-6 px-4 md:px-6" aria-label="Storefront shopping flow">
        <section className="grid gap-3 rounded-2xl border border-slate-100 bg-white p-5 shadow-xl shadow-slate-900/5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-emerald-600">Shop by category</p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-slate-900">Quick discovery</h2>
            </div>
            <Badge variant="outline" className="hidden h-8 border-orange-200 bg-orange-50 font-black text-orange-700 sm:inline-flex">
              {products.length} products available
            </Badge>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {categories.map((category) => (
              <button
                key={category}
                className={`min-w-max rounded-full border px-4 py-2 text-sm font-black transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-400/35 ${
                  activeCategory === category
                    ? "border-emerald-700 bg-emerald-700 text-white shadow-sm"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                }`}
                type="button"
                onClick={() => {
                  setActiveCategory(category);
                  if (category !== "All") {
                    onNavigate(collectionPath(category));
                  }
                }}
              >
                {category}
              </button>
            ))}
          </div>
        </section>

        {recentlyViewedProducts.length > 0 ? (
          <section className="grid gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xl shadow-slate-900/5" aria-labelledby="recently-viewed-title">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-emerald-600">History</p>
              <h2 id="recently-viewed-title" className="mt-1 text-xl font-black tracking-tight text-slate-900">Recently viewed</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {recentlyViewedProducts.map((product) => {
                const price = getVariantPrice(product.variants?.[0]);

                return (
                  <AppLink key={product.id} className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50/70 p-3 transition-colors hover:bg-slate-50 hover:border-slate-200" to={productPath(product.id)} onNavigate={onNavigate}>
                    <span className="font-black leading-snug text-slate-900">{product.title}</span>
                    <span className="text-sm font-bold text-emerald-700">{formatMoney(price?.amount, price?.currency)}</span>
                  </AppLink>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-3 rounded-2xl border border-slate-100 bg-white p-5 shadow-xl shadow-slate-900/5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-emerald-600">Results</p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-slate-900">
              {visibleProducts.length} of {products.length} products
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              ["featured", "Featured"],
              ["price-asc", "Price low"],
              ["price-desc", "Price high"],
              ["name", "A-Z"],
            ].map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={sortMode === value ? "default" : "outline"}
                className={sortMode === value ? "h-10 bg-emerald-700 font-black text-white hover:bg-emerald-800" : "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50"}
                onClick={() => setSortMode(value as typeof sortMode)}
              >
                <ArrowDownAZ className="size-4" aria-hidden="true" />
                <span>{label}</span>
              </Button>
            ))}
          </div>
        </section>

        <ProductGrid
          products={visibleProducts}
          isBusy={isBusy}
          isWishlisted={isWishlisted}
          onAddVariantToCart={addVariantToCart}
          onRefresh={loadProducts}
          onNavigate={onNavigate}
          onToggleWishlist={toggleWishlist}
          showDeal
        />
      </main>
    </>
  );
}
