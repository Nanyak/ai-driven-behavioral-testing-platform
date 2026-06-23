import { ArrowRight, CheckCircle2, ChevronDown, PackageCheck, Sparkles, Truck } from "lucide-react";
import { AppLink } from "./AppLink";
import { Badge } from "./ui/badge";

type StoreHeroProps = {
  onNavigate: (path: string) => void;
};

export function StoreHero({ onNavigate }: StoreHeroProps) {
  return (
    <section
      className="-mt-24 relative overflow-hidden min-h-[640px] grid grid-cols-1 gap-9 px-4 pb-16 pt-44 text-white md:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,440px)] lg:px-[max(24px,calc((100vw-1240px)/2))] lg:pt-48"
      style={{ background: "linear-gradient(135deg, #020617 0%, #052e16 40%, #064e3b 72%, #065f46 100%)" }}
      aria-labelledby="hero-title"
    >
      {/* Decorative ambient orbs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-32 right-1/4 size-[520px] rounded-full bg-emerald-500/15 blur-[80px]" />
        <div className="absolute bottom-0 left-0 size-[360px] rounded-full bg-emerald-400/10 blur-[60px]" />
        <div className="absolute top-1/2 right-0 size-[280px] rounded-full bg-orange-500/12 blur-[70px]" />
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: "radial-gradient(#ffffff 1px, transparent 1px)", backgroundSize: "28px 28px" }}
        />
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      </div>

      {/* Scroll cue */}
      <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 hidden flex-col items-center gap-1.5 lg:flex" aria-hidden="true">
        <span className="text-[11px] font-bold uppercase tracking-widest text-white/40">Scroll</span>
        <ChevronDown className="size-4 text-white/40" style={{ animation: "var(--animate-bounce-subtle)" }} />
      </div>

      <div className="relative self-end">
        <Badge
          className="mb-5 border border-white/25 bg-white/10 text-white backdrop-blur hover:bg-white/15"
          style={{ animation: "var(--animate-fade-in-up)", animationDelay: "0ms" }}
        >
          <Sparkles className="size-3" aria-hidden="true" />
          New season test catalog
        </Badge>
        <h1
          id="hero-title"
          className="max-w-3xl text-5xl font-black leading-[0.93] tracking-tight sm:text-6xl lg:text-7xl xl:text-8xl"
          style={{ animation: "var(--animate-fade-in-up)", animationDelay: "80ms" }}
        >
          Everyday gear,<br />checkout ready.
        </h1>
        <p
          className="mt-6 max-w-xl text-base font-medium leading-8 text-white/85 sm:text-lg"
          style={{ animation: "var(--animate-fade-in-up)", animationDelay: "160ms" }}
        >
          Browse seeded Medusa products, sign in as a shopper, add variants, and complete a full checkout —
          all from a storefront built for fast product discovery.
        </p>
        <div
          className="mt-9 flex flex-col gap-3 sm:flex-row"
          style={{ animation: "var(--animate-fade-in-up)", animationDelay: "240ms" }}
        >
          <AppLink
            className="inline-flex h-12 cursor-pointer items-center gap-2 rounded-lg bg-orange-500 px-6 text-base font-black text-white shadow-lg shadow-orange-500/30 transition-all duration-200 hover:bg-orange-600 hover:shadow-orange-500/50 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-400/50"
            to="/"
            onNavigate={onNavigate}
          >
            <span>Shop featured</span>
            <ArrowRight className="size-4" aria-hidden="true" />
          </AppLink>
          <AppLink
            className="inline-flex h-12 cursor-pointer items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-6 text-base font-black text-white backdrop-blur transition-all duration-200 hover:bg-white/20 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
            to="/cart"
            onNavigate={onNavigate}
          >
            View cart
          </AppLink>
        </div>
      </div>

      <div className="relative hidden min-h-80 self-stretch md:grid">
        <div className="grid min-h-80 w-full content-end justify-self-end rounded-2xl border border-white/20 bg-white/8 p-7 shadow-2xl shadow-black/40 backdrop-blur-2xl lg:w-[360px]">
          <div className="mb-4 flex items-center gap-2 text-sm font-black text-white/90">
            <Sparkles className="size-4 text-emerald-400" aria-hidden="true" />
            <span>Seeded arrivals</span>
          </div>
          <strong className="text-3xl font-black leading-tight tracking-tight">
            Cart-ready variants
          </strong>
          <p className="mt-4 max-w-72 text-sm font-medium leading-6 text-white/70">
            Catalog, customer, shipping, and payment paths in one guided flow — ready for behavioral analysis.
          </p>
        </div>

        <div className="absolute left-4 top-10 flex items-center gap-2.5 rounded-xl border border-white/25 bg-white/10 px-4 py-3 text-sm font-black backdrop-blur-xl lg:left-auto lg:right-80">
          <PackageCheck className="size-4 text-emerald-400" aria-hidden="true" />
          Variant selection
        </div>
        <div className="absolute bottom-6 left-4 flex items-center gap-2.5 rounded-xl border border-white/25 bg-white/10 px-4 py-3 text-sm font-black backdrop-blur-xl lg:left-auto lg:right-52">
          <Truck className="size-4 text-orange-400" aria-hidden="true" />
          Shipping validation
        </div>
        <div className="absolute left-4 top-36 flex items-center gap-2.5 rounded-xl border border-white/20 bg-emerald-950/60 px-4 py-3 text-sm font-black backdrop-blur-xl lg:left-auto lg:right-52">
          <CheckCircle2 className="size-4 text-emerald-400" aria-hidden="true" />
          Checkout flow online
        </div>
      </div>
    </section>
  );
}
