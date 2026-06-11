import { useEffect, useState } from "react";
import { PackageCheck, ShoppingBag } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";
import type { Order } from "../types/storefront";
import { formatMoney } from "../utils/money";

type OrdersPageProps = {
  onNavigate: (path: string) => void;
};

export function OrdersPage({ onNavigate }: OrdersPageProps) {
  const { customer, isBusy, loadOrders, recentOrderIds } = useStorefront();
  const [orders, setOrders] = useState<Order[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void loadOrders().then((loadedOrders) => {
      if (isMounted) {
        setOrders(loadedOrders);
        setHasLoaded(true);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Orders</p>
        <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">Order history</h1>
        <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
          Review completed checkouts, jump back into order confirmations, and keep guest orders reachable on this device.
        </p>
      </div>

      {!customer ? (
        <Card className="rounded-lg border-orange-100 bg-orange-50 shadow-xl shadow-orange-950/5">
          <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-black text-orange-950">Sign in for full order history</h2>
              <p className="mt-1 font-semibold text-orange-900/70">
                Showing saved guest orders from this browser. Customer orders appear after sign in.
              </p>
            </div>
            <AppLink className={buttonVariants({ className: "h-10 bg-orange-500 px-5 font-black text-white hover:bg-orange-600" })} to="/signin" onNavigate={onNavigate}>
              Sign in
            </AppLink>
          </CardContent>
        </Card>
      ) : null}

      {orders.length > 0 ? (
        <section className="grid gap-4">
          {orders.map((order) => (
            <Card key={order.id} className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
              <CardContent className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PackageCheck className="size-5 text-emerald-600" aria-hidden="true" />
                    <h2 className="truncate text-xl font-black text-emerald-950">
                      {order.display_id ? `Order #${order.display_id}` : order.id}
                    </h2>
                  </div>
                  <p className="mt-2 font-semibold text-emerald-800/70">
                    {(order.items ?? []).length} items - {formatMoney(order.total, order.currency_code || "USD")}
                  </p>
                  {order.created_at ? (
                    <p className="mt-1 text-sm font-bold text-emerald-700">
                      Placed {new Date(order.created_at).toLocaleDateString()}
                    </p>
                  ) : null}
                </div>
                <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to={`/orders/${encodeURIComponent(order.id)}`} onNavigate={onNavigate}>
                  View order
                </AppLink>
              </CardContent>
            </Card>
          ))}
        </section>
      ) : (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid min-h-72 justify-items-start gap-4 p-6">
            <ShoppingBag className="size-11 text-emerald-600" aria-hidden="true" />
            <h2 className="text-3xl font-black tracking-tight text-emerald-950">
              {isBusy || !hasLoaded ? "Loading orders" : "No orders yet"}
            </h2>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              {recentOrderIds.length > 0
                ? "Saved order IDs could not be loaded from Medusa right now."
                : "Completed checkouts will appear here."}
            </p>
            <AppLink className={buttonVariants({ className: "h-10 bg-orange-500 px-5 font-black text-white hover:bg-orange-600" })} to="/" onNavigate={onNavigate}>
              Continue shopping
            </AppLink>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
