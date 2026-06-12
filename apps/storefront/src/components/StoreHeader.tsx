import { Bell, Heart, LayoutGrid, Menu, Search, ShoppingBag, UserRound } from "lucide-react";
import { AppLink } from "./AppLink";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";

type StoreHeaderProps = {
  itemCount: number;
  customerEmail?: string;
  onNavigate: (path: string) => void;
  onSearchChange: (value: string) => void;
  searchQuery: string;
  status: string;
  unreadNotificationCount: number;
  wishlistCount: number;
};

export function StoreHeader({ itemCount, customerEmail, onNavigate, onSearchChange, searchQuery, unreadNotificationCount, wishlistCount }: StoreHeaderProps) {
  return (
    <header className="sticky top-3 z-20 mx-auto w-[calc(100%-1.5rem)] max-w-7xl rounded-2xl border border-slate-200/80 bg-white/95 shadow-xl shadow-slate-900/8 backdrop-blur">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2.5 md:grid-cols-[auto_auto_1fr_auto]">

        {/* Logo */}
        <AppLink
          className="flex min-w-max cursor-pointer items-center gap-2.5"
          to="/"
          onNavigate={onNavigate}
        >
          <span className="flex size-9 items-center justify-center rounded-xl bg-emerald-600 text-sm font-black text-white shadow-inner shadow-emerald-950/20">
            B
          </span>
          <span className="hidden text-sm font-black tracking-tight text-slate-900 lg:inline">
            Behavior Storefront
          </span>
        </AppLink>

        {/* Nav — desktop only */}
        <nav className="hidden items-center gap-0.5 md:flex" aria-label="Store navigation">
          <AppLink
            className="cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            to="/"
            onNavigate={onNavigate}
          >
            Shop
          </AppLink>
          <AppLink
            className="cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-orange-600 transition-colors hover:bg-orange-50"
            to="/deals"
            onNavigate={onNavigate}
          >
            Deals
          </AppLink>
          {customerEmail && (
            <AppLink
              className="cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
              to="/orders"
              onNavigate={onNavigate}
            >
              Orders
            </AppLink>
          )}
        </nav>

        {/* Mobile hamburger menu */}
        <Sheet>
          <SheetTrigger
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 md:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-4" aria-hidden="true" />
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetHeader className="border-b border-slate-100 px-5 py-4">
              <SheetTitle className="flex items-center gap-2.5 text-left">
                <span className="flex size-8 items-center justify-center rounded-xl bg-emerald-600 text-xs font-black text-white">B</span>
                <span className="font-black tracking-tight text-slate-900">Behavior Storefront</span>
              </SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 p-3" aria-label="Mobile navigation">
              <AppLink
                className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                to="/"
                onNavigate={onNavigate}
              >
                <LayoutGrid className="size-4 text-slate-400" aria-hidden="true" />
                Shop all products
              </AppLink>
              <AppLink
                className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-orange-600 transition-colors hover:bg-orange-50"
                to="/deals"
                onNavigate={onNavigate}
              >
                <ShoppingBag className="size-4 text-orange-400" aria-hidden="true" />
                Deals
              </AppLink>
              {customerEmail ? (
                <>
                  <AppLink
                    className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                    to="/orders"
                    onNavigate={onNavigate}
                  >
                    <UserRound className="size-4 text-slate-400" aria-hidden="true" />
                    My orders
                  </AppLink>
                  <AppLink
                    className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                    to="/wishlist"
                    onNavigate={onNavigate}
                  >
                    <Heart className="size-4 text-slate-400" aria-hidden="true" />
                    Wishlist
                    {wishlistCount > 0 && (
                      <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-black text-white">
                        {wishlistCount}
                      </span>
                    )}
                  </AppLink>
                  <AppLink
                    className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                    to="/profile"
                    onNavigate={onNavigate}
                  >
                    <UserRound className="size-4 text-slate-400" aria-hidden="true" />
                    Profile
                  </AppLink>
                </>
              ) : (
                <AppLink
                  className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  to="/signin"
                  onNavigate={onNavigate}
                >
                  <UserRound className="size-4 text-slate-400" aria-hidden="true" />
                  Sign in
                </AppLink>
              )}
            </nav>
          </SheetContent>
        </Sheet>

        {/* Search */}
        <label
          className="order-3 col-span-3 flex h-10 cursor-text items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-slate-400 transition-colors focus-within:border-emerald-500 focus-within:bg-white focus-within:ring-4 focus-within:ring-emerald-500/12 md:order-none md:col-span-1"
          aria-label="Search products"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <Input
            className="h-9 border-0 bg-transparent px-0 text-sm font-medium text-slate-900 shadow-none placeholder:text-slate-400 focus-visible:ring-0"
            placeholder="Search products..."
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            onFocus={() => onNavigate("/")}
          />
        </label>

        {/* Actions */}
        <div className="flex items-center gap-1.5">

          {/* User / Sign in */}
          <AppLink
            className="flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
            to={customerEmail ? "/profile" : "/signin"}
            onNavigate={onNavigate}
          >
            <UserRound className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden max-w-28 truncate sm:inline">
              {customerEmail || "Sign in"}
            </span>
          </AppLink>

          {/* Wishlist — icon + floating badge */}
          <AppLink
            className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
            to="/wishlist"
            onNavigate={onNavigate}
            aria-label={`Wishlist, ${wishlistCount} saved`}
          >
            <Heart className="size-4" aria-hidden="true" />
            {wishlistCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex size-[18px] items-center justify-center rounded-full bg-slate-900 text-[10px] font-black leading-none text-white">
                {wishlistCount}
              </span>
            )}
          </AppLink>

          {/* Alerts — icon + floating badge */}
          <AppLink
            className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
            to="/notifications"
            onNavigate={onNavigate}
            aria-label={`${unreadNotificationCount} notifications`}
          >
            <Bell className="size-4" aria-hidden="true" />
            {unreadNotificationCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex size-[18px] items-center justify-center rounded-full bg-orange-500 text-[10px] font-black leading-none text-white">
                {unreadNotificationCount}
              </span>
            )}
          </AppLink>

          {/* Cart — CTA */}
          <AppLink
            className="flex h-9 cursor-pointer items-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-black text-white transition-colors hover:bg-emerald-700"
            to="/cart"
            onNavigate={onNavigate}
            aria-label={`Cart, ${itemCount} items`}
          >
            <ShoppingBag className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Cart</span>
            <span className="flex size-5 items-center justify-center rounded-full bg-white text-[11px] font-black leading-none text-emerald-700">
              {itemCount}
            </span>
          </AppLink>

        </div>
      </div>
    </header>
  );
}
