import { useEffect, useState } from "react";
import { CheckCircle2, Clock, PackageCheck, RotateCcw, ShoppingBag, Truck, XCircle } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { useStorefront } from "../context/StorefrontContext";
import type { Order } from "../types/storefront";
import { formatMoney } from "../utils/money";
import { ORDER_STAGE_LABEL, canBuyAgain, deriveOrderStage, type OrderStage } from "../utils/orderStatus";

type OrderPageProps = {
  orderId: string;
  onNavigate: (path: string) => void;
};

const STAGE_BADGE: Record<OrderStage, string> = {
  to_pay: "bg-amber-100 text-amber-800",
  to_ship: "bg-sky-100 text-sky-800",
  shipping: "bg-indigo-100 text-indigo-800",
  to_receive: "bg-violet-100 text-violet-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-700",
};

const STAGE_STEP: Record<OrderStage, number> = {
  to_pay: 0,
  to_ship: 1,
  shipping: 2,
  to_receive: 3,
  completed: 3,
  cancelled: -1,
};

export function OrderPage({ orderId, onNavigate }: OrderPageProps) {
  const { addVariantToCart, isBusy, loadOrder } = useStorefront();
  const [order, setOrder] = useState<Order | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const currency = order?.currency_code || "USD";

  useEffect(() => {
    let isMounted = true;

    void loadOrder(orderId).then((loadedOrder) => {
      if (isMounted) {
        setOrder(loadedOrder);
        setHasLoaded(true);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [orderId]);

  const stage = order ? deriveOrderStage(order) : null;

  async function handleBuyAgain() {
    const variantIds = (order?.items ?? [])
      .map((item) => item.variant_id)
      .filter((id): id is string => Boolean(id));
    for (const variantId of variantIds) {
      await addVariantToCart(variantId);
    }
    onNavigate("/cart");
  }

  return (
    <main className="mx-auto grid max-w-3xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <AppLink className="text-sm font-black text-emerald-700 hover:underline" to="/orders" onNavigate={onNavigate}>
          ← Back to my purchases
        </AppLink>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-black tracking-tight text-emerald-950 md:text-4xl">
            {order?.display_id ? `Order #${order.display_id}` : "Order"}
          </h1>
          {stage ? (
            <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide ${STAGE_BADGE[stage]}`}>
              {ORDER_STAGE_LABEL[stage]}
            </span>
          ) : null}
        </div>
      </div>

      {order && stage ? (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid gap-5 p-5">
            {stage === "cancelled" ? (
              <div className="flex items-center gap-3 rounded-lg border border-rose-100 bg-rose-50 p-4">
                <XCircle className="size-6 text-rose-600" aria-hidden="true" />
                <p className="font-bold text-rose-800">This order was cancelled.</p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-4">
                {[
                  ["Placed", CheckCircle2],
                  ["Processing", Clock],
                  ["Shipped", Truck],
                  ["Delivered", PackageCheck],
                ].map(([title, Icon], index) => {
                  const done = index <= STAGE_STEP[stage];
                  return (
                    <div
                      key={title as string}
                      className={`flex items-center gap-2 rounded-lg border p-3 ${done ? "border-emerald-200 bg-emerald-50/60" : "border-emerald-100 bg-white"}`}
                    >
                      <span className={`flex size-8 items-center justify-center rounded-lg ${done ? "bg-emerald-600 text-white" : "bg-emerald-100 text-emerald-500"}`}>
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className={`text-sm font-black ${done ? "text-emerald-950" : "text-emerald-500"}`}>{title as string}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="grid gap-2">
              {(order.items ?? []).map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2">
                  <span className="font-bold text-emerald-950">{item.title}</span>
                  <span className="font-bold text-emerald-800">
                    {item.quantity} x {formatMoney(item.unit_price, currency)}
                  </span>
                </div>
              ))}
            </div>

            <div className="grid gap-2 rounded-lg border border-emerald-100 p-4">
              <div className="flex items-center justify-between gap-3">
                <span>Subtotal</span>
                <strong>{formatMoney(order.subtotal, currency)}</strong>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Shipping</span>
                <strong>{formatMoney(order.shipping_total, currency)}</strong>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Tax</span>
                <strong>{formatMoney(order.tax_total, currency)}</strong>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3 text-xl font-black text-emerald-950">
                <span>Total</span>
                <strong>{formatMoney(order.total, currency)}</strong>
              </div>
            </div>

            {canBuyAgain(stage) ? (
              <Button type="button" onClick={() => void handleBuyAgain()} disabled={isBusy} className="h-10 w-fit bg-orange-500 px-4 font-black text-white hover:bg-orange-600">
                <RotateCcw className="size-4" aria-hidden="true" />
                <span>Buy again</span>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-emerald-700">
            <ShoppingBag className="size-8" aria-hidden="true" />
            <span className="font-bold">{isBusy || !hasLoaded ? "Loading order..." : "Order could not be loaded."}</span>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
