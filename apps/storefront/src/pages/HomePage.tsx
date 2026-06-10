import { PackageCheck, ShieldCheck, Sparkles, Truck } from "lucide-react";
import { ProductGrid } from "../components/ProductGrid";
import { StoreHero } from "../components/StoreHero";
import { Badge } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";

type HomePageProps = {
  onNavigate: (path: string) => void;
};

const categories = ["New Arrivals", "Best Sellers", "Everyday Gear", "Accessories", "Checkout Picks", "Test Catalog"];

const promos = [
  {
    title: "Browse by intent",
    text: "Jump from seeded arrivals into product detail pages without exposing checkout too early.",
    icon: Sparkles,
  },
  {
    title: "Variants first",
    text: "Every card keeps variant depth visible so test shoppers know what can be added.",
    icon: PackageCheck,
  },
  {
    title: "Checkout later",
    text: "Cart and checkout stay in the dedicated cart route, matching familiar ecommerce flow.",
    icon: Truck,
  },
];

export function HomePage({ onNavigate }: HomePageProps) {
  const { isBusy, loadProducts, paymentProviders, products, shippingOptions } = useStorefront();

  return (
    <>
      <StoreHero onNavigate={onNavigate} />
      <main className="mx-auto grid max-w-7xl gap-6 px-4 md:px-6" aria-label="Storefront shopping flow">
        <section className="grid gap-3 rounded-lg border border-emerald-100 bg-white p-4 shadow-xl shadow-emerald-950/5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Shop by category</p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-emerald-950">Quick discovery</h2>
            </div>
            <Badge variant="outline" className="hidden h-8 border-orange-200 bg-orange-50 font-black text-orange-700 sm:inline-flex">
              {products.length} products available
            </Badge>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {categories.map((category) => (
              <a
                key={category}
                className="min-w-max rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-800 transition-colors hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-400/35"
                href="#catalog"
              >
                {category}
              </a>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr_1fr]">
          <Card className="rounded-lg border-emerald-100 bg-emerald-950 py-0 text-white shadow-xl shadow-emerald-950/10">
            <CardContent className="grid min-h-52 content-end gap-3 p-6">
              <Badge className="w-fit bg-orange-500 font-black text-white hover:bg-orange-500">Storefront flow</Badge>
              <h2 className="text-3xl font-black leading-none tracking-tight">Find the product first. Checkout when ready.</h2>
              <p className="max-w-xl font-semibold leading-7 text-white/75">
                Nike-style editorial discovery meets Shopee-style quick browsing: clear categories, promo context,
                and dense product access before cart decisions.
              </p>
            </CardContent>
          </Card>
          <Card className="rounded-lg border-emerald-100 bg-white py-0 shadow-xl shadow-emerald-950/5">
            <CardContent className="grid min-h-52 content-between p-6">
              <ShieldCheck className="size-8 text-emerald-600" aria-hidden="true" />
              <div>
                <p className="text-sm font-black uppercase text-emerald-700">Readiness</p>
                <strong className="mt-1 block text-2xl font-black text-emerald-950">{paymentProviders.length} payment providers</strong>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-lg border-emerald-100 bg-white py-0 shadow-xl shadow-emerald-950/5">
            <CardContent className="grid min-h-52 content-between p-6">
              <Truck className="size-8 text-orange-500" aria-hidden="true" />
              <div>
                <p className="text-sm font-black uppercase text-emerald-700">Delivery path</p>
                <strong className="mt-1 block text-2xl font-black text-emerald-950">{shippingOptions.length} shipping options</strong>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {promos.map((promo) => {
            const Icon = promo.icon;

            return (
              <Card key={promo.title} className="rounded-lg border-emerald-100 bg-white py-0 shadow-xl shadow-emerald-950/5">
                <CardContent className="grid gap-4 p-5">
                  <Icon className="size-7 text-emerald-600" aria-hidden="true" />
                  <div>
                    <h3 className="text-lg font-black text-emerald-950">{promo.title}</h3>
                    <p className="mt-2 text-sm font-semibold leading-6 text-emerald-800/75">{promo.text}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>

        <ProductGrid products={products} isBusy={isBusy} onRefresh={loadProducts} onNavigate={onNavigate} />
      </main>
    </>
  );
}
