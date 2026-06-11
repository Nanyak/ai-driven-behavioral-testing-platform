import { Heart, LogOut, PackageCheck, ShoppingBag, UserRound } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";

type ProfilePageProps = {
  onNavigate: (path: string) => void;
};

export function ProfilePage({ onNavigate }: ProfilePageProps) {
  const { customer, logoutCustomer, savedAddresses, status } = useStorefront();

  if (!customer) {
    return (
      <main className="mx-auto grid max-w-7xl px-4 py-14 md:px-6">
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid min-h-72 justify-items-start gap-4 p-6">
            <UserRound className="size-11 text-emerald-600" aria-hidden="true" />
            <h1 className="text-4xl font-black tracking-tight text-emerald-950">Sign in to view your profile</h1>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              Your shopper details and checkout identity will appear here.
            </p>
            <AppLink className={buttonVariants({ className: "h-10 bg-orange-500 px-5 font-black text-white hover:bg-orange-600" })} to="/signin" onNavigate={onNavigate}>
              Sign in
            </AppLink>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-7xl px-4 py-14 md:px-6">
      <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
        <CardContent className="grid gap-6 p-6">
          <div className="grid gap-2">
            <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Profile</p>
            <h1 className="text-4xl font-black tracking-tight text-emerald-950">
              {customer.first_name || "Behavior"} {customer.last_name || "Shopper"}
            </h1>
            <p className="font-semibold leading-7 text-emerald-900/70">{status}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2 rounded-lg border border-emerald-100 bg-emerald-50/70 p-4">
              <span className="text-sm font-black text-emerald-700">Email</span>
              <strong className="break-all text-emerald-950">{customer.email}</strong>
            </div>
            <div className="grid gap-2 rounded-lg border border-emerald-100 bg-emerald-50/70 p-4">
              <span className="text-sm font-black text-emerald-700">Customer ID</span>
              <strong className="break-all text-emerald-950">{customer.id}</strong>
            </div>
          </div>
          <section className="grid gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Address book</p>
              <h2 className="mt-1 text-2xl font-black text-emerald-950">{savedAddresses.length} saved addresses</h2>
            </div>
            {savedAddresses.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2">
                {savedAddresses.map((address) => (
                  <div key={address.id || address.address_1} className="grid gap-1 rounded-lg border border-emerald-100 bg-emerald-50/70 p-4">
                    <strong className="text-emerald-950">{address.label || "Saved address"}</strong>
                    <span className="font-semibold text-emerald-800/75">{address.address_1}</span>
                    <span className="font-semibold text-emerald-800/75">{address.city}, {address.postal_code}</span>
                    <span className="font-semibold uppercase text-emerald-800/75">{address.country_code}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/50 p-4 font-bold text-emerald-700">
                Save an address during checkout to reuse it here.
              </p>
            )}
          </section>
          <div className="flex flex-col gap-3 sm:flex-row">
            <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to="/cart" onNavigate={onNavigate}>
              <ShoppingBag className="size-4" aria-hidden="true" />
              <span>View cart</span>
            </AppLink>
            <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to="/orders" onNavigate={onNavigate}>
              <PackageCheck className="size-4" aria-hidden="true" />
              <span>Orders</span>
            </AppLink>
            <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to="/wishlist" onNavigate={onNavigate}>
              <Heart className="size-4" aria-hidden="true" />
              <span>Saved</span>
            </AppLink>
            <Button type="button" className="h-10 bg-orange-500 font-black text-white hover:bg-orange-600" onClick={logoutCustomer}>
              <LogOut className="size-4" aria-hidden="true" />
              <span>Logout</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
