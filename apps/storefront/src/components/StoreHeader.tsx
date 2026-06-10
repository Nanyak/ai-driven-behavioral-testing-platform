import { Search, ShoppingBag, UserRound } from "lucide-react";
import { AppLink } from "./AppLink";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";

type StoreHeaderProps = {
  itemCount: number;
  customerEmail?: string;
  onNavigate: (path: string) => void;
  status: string;
};

export function StoreHeader({ itemCount, customerEmail, onNavigate, status }: StoreHeaderProps) {
  return (
    <header className="sticky top-3 z-20 mx-auto grid w-[calc(100%-1.5rem)] max-w-7xl grid-cols-[1fr_auto] items-center gap-3 rounded-lg border border-emerald-200/80 bg-white/95 p-3 shadow-xl shadow-emerald-950/10 backdrop-blur lg:grid-cols-[auto_minmax(260px,460px)_1fr]">
      <AppLink className="flex min-w-max items-center gap-3 font-black tracking-tight" to="/" onNavigate={onNavigate}>
        <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-600 font-black text-white shadow-inner shadow-emerald-950/25">
          B
        </span>
        <span className="hidden text-base sm:inline">Behavior Storefront</span>
      </AppLink>
      <label className="order-3 col-span-2 flex h-11 items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 text-emerald-700 focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-500/15 lg:order-none lg:col-span-1" aria-label="Search products">
        <Search className="size-4" aria-hidden="true" />
        <Input className="h-9 border-0 bg-transparent px-0 font-semibold shadow-none focus-visible:ring-0" placeholder="Search catalog" />
      </label>
      <div className="flex min-w-0 items-center justify-end gap-2">
        <nav className="hidden items-center gap-1 text-sm font-black md:flex" aria-label="Store navigation">
          <AppLink className="rounded-lg px-3 py-2 text-emerald-800 transition-colors hover:bg-emerald-50" to="/" onNavigate={onNavigate}>
            Shop
          </AppLink>
          <AppLink className="rounded-lg px-3 py-2 text-emerald-800 transition-colors hover:bg-emerald-50" to="/profile" onNavigate={onNavigate}>
            Profile
          </AppLink>
        </nav>
        <Badge variant="outline" className="hidden h-9 max-w-52 border-emerald-200 bg-emerald-50 px-3 font-black text-emerald-700 lg:inline-flex">
          <span className="truncate">{status}</span>
        </Badge>
        <AppLink className="flex h-10 min-w-10 items-center justify-center gap-2 rounded-full border border-emerald-200 bg-white px-3 font-bold transition-shadow hover:shadow-lg hover:shadow-emerald-950/10" to={customerEmail ? "/profile" : "/signin"} onNavigate={onNavigate}>
          <UserRound className="size-4" aria-hidden="true" />
          <span className="hidden max-w-40 truncate sm:inline">{customerEmail || "Sign in"}</span>
        </AppLink>
        <AppLink className="flex h-10 items-center justify-center gap-2 rounded-full bg-emerald-950 px-4 font-black text-white transition-shadow hover:bg-emerald-900 hover:shadow-lg hover:shadow-emerald-950/20" to="/cart" onNavigate={onNavigate} aria-label={`Cart with ${itemCount} items`}>
          <ShoppingBag className="size-4 text-white" aria-hidden="true" />
          <span className="hidden text-white sm:inline">Cart</span>
          <strong className="rounded-full bg-white px-2 py-0.5 text-xs leading-none text-emerald-950">{itemCount}</strong>
        </AppLink>
      </div>
    </header>
  );
}
