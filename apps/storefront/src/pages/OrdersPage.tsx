import { useEffect, useMemo, useState } from "react";
import { PackageCheck, RotateCcw, ShoppingBag } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";
import type { Order } from "../types/storefront";
import { formatMoney } from "../utils/money";
import { ORDER_STAGE_LABEL, ORDER_STAGES, canBuyAgain, deriveOrderStage, type OrderStage } from "../utils/orderStatus";

type OrdersPageProps = {
  onNavigate: (path: string) => void;
};

type Filter = OrderStage | "all";

const STAGE_BADGE: Record<OrderStage, string> = {
  to_pay: "bg-amber-100 text-amber-800",
  to_ship: "bg-sky-100 text-sky-800",
  shipping: "bg-indigo-100 text-indigo-800",
  to_receive: "bg-violet-100 text-violet-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-700",
};

export function OrdersPage({ onNavigate }: OrdersPageProps) {
  const { addVariantToCart, customer, isBusy, loadOrders, recentOrderIds } = useStorefront();
  const [orders, setOrders] = useState<Order[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

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

  const stageOf = useMemo(() => {
    const map = new Map<string, OrderStage>();
    for (const order of orders) {
      map.set(order.id, deriveOrderStage(order));
    }
    return map;
  }, [orders]);

  const counts = useMemo(() => {
    const next: Record<OrderStage, number> = {
      to_pay: 0,
      to_ship: 0,
      shipping: 0,
      to_receive: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const stage of stageOf.values()) {
      next[stage] += 1;
    }
    return next;
  }, [stageOf]);

  const visibleOrders = filter === "all" ? orders : orders.filter((order) => stageOf.get(order.id) === filter);

  async function handleBuyAgain(order: Order) {
    const variantIds = (order.items ?? [])
      .map((item) => item.variant_id)
      .filter((id): id is string => Boolean(id));
    for (const variantId of variantIds) {
      await addVariantToCart(variantId);
    }
    onNavigate("/cart");
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Orders</p>
        <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">My purchases</h1>
        <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
          Track every order by stage. Cancel before shipping, request returns after delivery, or buy again in one tap.
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
        <>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            <FilterTab label="All" count={orders.length} active={filter === "all"} onClick={() => setFilter("all")} />
            {ORDER_STAGES.map((stage) => (
              <FilterTab
                key={stage}
                label={ORDER_STAGE_LABEL[stage]}
                count={counts[stage]}
                active={filter === stage}
                onClick={() => setFilter(stage)}
              />
            ))}
          </div>

          <section className="grid gap-4">
            {visibleOrders.length === 0 ? (
              <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
                <CardContent className="grid justify-items-start gap-2 p-6">
                  <PackageCheck className="size-8 text-emerald-600" aria-hidden="true" />
                  <p className="font-semibold text-emerald-900/70">No orders in this stage.</p>
                </CardContent>
              </Card>
            ) : (
              visibleOrders.map((order) => {
                const stage = stageOf.get(order.id) ?? "to_ship";
                const itemCount = (order.items ?? []).reduce((total, item) => total + item.quantity, 0);

                return (
                  <Card key={order.id} className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
                    <CardContent className="grid gap-4 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <PackageCheck className="size-5 text-emerald-600" aria-hidden="true" />
                          <h2 className="text-lg font-black text-emerald-950">
                            {order.display_id ? `Order #${order.display_id}` : order.id}
                          </h2>
                        </div>
                        <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide ${STAGE_BADGE[stage]}`}>
                          {ORDER_STAGE_LABEL[stage]}
                        </span>
                      </div>

                      <div className="grid gap-1">
                        {(order.items ?? []).slice(0, 2).map((item) => (
                          <div key={item.id} className="flex items-center justify-between gap-3 text-sm font-bold text-emerald-900/80">
                            <span className="truncate">{item.title}</span>
                            <span className="shrink-0">x{item.quantity}</span>
                          </div>
                        ))}
                        {(order.items ?? []).length > 2 ? (
                          <p className="text-sm font-semibold text-emerald-700">
                            +{(order.items ?? []).length - 2} more item(s)
                          </p>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-end justify-between gap-3">
                        <div>
                          {order.created_at ? (
                            <p className="text-sm font-bold text-emerald-700">
                              Placed {new Date(order.created_at).toLocaleDateString()}
                            </p>
                          ) : null}
                          <p className="text-sm font-semibold text-emerald-900/70">
                            {itemCount} item(s) - Total {formatMoney(order.total, order.currency_code || "USD")}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {canBuyAgain(stage) ? (
                            <Button
                              type="button"
                              onClick={() => void handleBuyAgain(order)}
                              disabled={isBusy}
                              className="h-10 bg-orange-500 px-4 font-black text-white hover:bg-orange-600"
                            >
                              <RotateCcw className="size-4" aria-hidden="true" />
                              <span>Buy again</span>
                            </Button>
                          ) : null}
                          <AppLink
                            className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })}
                            to={`/orders/${encodeURIComponent(order.id)}`}
                            onNavigate={onNavigate}
                          >
                            View order
                          </AppLink>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </section>
        </>
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

type FilterTabProps = {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
};

function FilterTab({ label, count, active, onClick }: FilterTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-black transition-colors ${
        active
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-emerald-200 bg-white text-emerald-800 hover:bg-emerald-50"
      }`}
    >
      <span>{label}</span>
      <span className={`rounded-full px-1.5 text-xs ${active ? "bg-white/20" : "bg-emerald-100 text-emerald-700"}`}>{count}</span>
    </button>
  );
}
