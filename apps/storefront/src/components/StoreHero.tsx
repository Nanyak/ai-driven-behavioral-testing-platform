import { ArrowRight, CheckCircle2, PackageCheck, Sparkles, Truck } from "lucide-react";
import { AppLink } from "./AppLink";
import { Badge } from "./ui/badge";
import { buttonVariants } from "./ui/button";

type StoreHeroProps = {
  onNavigate: (path: string) => void;
};

export function StoreHero({ onNavigate }: StoreHeroProps) {
  return (
    <section
      className="-mt-24 grid min-h-[620px] grid-cols-1 gap-9 bg-[linear-gradient(112deg,rgba(6,78,59,.96)_8%,rgba(5,150,105,.78)_52%,rgba(249,115,22,.28)),url('https://images.unsplash.com/photo-1555529669-e69e7aa0ba9a?auto=format&fit=crop&w=1800&q=80')] bg-cover bg-center px-4 pb-12 pt-40 text-white md:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)] lg:px-[max(24px,calc((100vw-1240px)/2))] lg:pt-44"
      aria-labelledby="hero-title"
    >
      <div className="self-end">
        <Badge className="mb-4 bg-emerald-200 text-emerald-950 hover:bg-emerald-200">
          New season test catalog
        </Badge>
        <h1 id="hero-title" className="max-w-4xl text-5xl font-black leading-[.94] tracking-normal sm:text-6xl lg:text-8xl">
          Everyday gear, checkout ready.
        </h1>
        <p className="mt-5 max-w-2xl text-base font-semibold leading-8 text-white/90 sm:text-lg">
          Browse seeded Medusa products, sign in as a shopper, add variants, and run a full checkout
          from a storefront built for fast product discovery.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <AppLink className={buttonVariants({ className: "h-11 bg-orange-500 px-5 font-black text-white hover:bg-orange-600" })} to="/" onNavigate={onNavigate}>
            <span>Shop featured</span>
            <ArrowRight className="size-4" aria-hidden="true" />
          </AppLink>
          <AppLink className={buttonVariants({ variant: "outline", className: "h-11 border-white/50 bg-white/10 px-5 font-black text-white hover:bg-white/20 hover:text-white" })} to="/cart" onNavigate={onNavigate}>
            View cart
          </AppLink>
        </div>
      </div>

      <div className="relative hidden min-h-80 self-stretch md:grid">
        <div className="grid min-h-80 w-full content-end justify-self-end rounded-lg border border-white/40 bg-white/15 p-7 shadow-2xl shadow-emerald-950/35 backdrop-blur-xl lg:w-[340px]">
          <div className="mb-3 flex items-center gap-2 font-black">
            <Sparkles className="size-5" />
            <span>Seeded arrivals</span>
          </div>
          <strong className="text-3xl font-black leading-none">Cart-ready variants</strong>
          <small className="mt-4 max-w-72 text-sm font-semibold leading-6 text-white/80">
            Catalog, customer, shipping, and payment paths in one guided flow.
          </small>
        </div>
        <div className="absolute left-4 top-8 flex items-center gap-2 rounded-lg border border-white/40 bg-white/15 px-4 py-3 font-black backdrop-blur-xl lg:left-auto lg:right-72">
          <PackageCheck className="size-4" />
          Variant selection
        </div>
        <div className="absolute bottom-6 right-8 flex items-center gap-2 rounded-lg border border-white/40 bg-white/15 px-4 py-3 font-black backdrop-blur-xl">
          <Truck className="size-4" />
          Shipping validation
        </div>
        <div className="absolute bottom-6 left-4 flex items-center gap-2 rounded-lg border border-white/40 bg-emerald-950/70 px-4 py-3 font-black backdrop-blur-xl lg:left-auto lg:right-52">
          <CheckCircle2 className="size-4" />
          Checkout flow online
        </div>
      </div>
    </section>
  );
}
