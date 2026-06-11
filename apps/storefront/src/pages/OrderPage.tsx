import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Clock, PackageCheck, RotateCcw, ShoppingBag, XCircle } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Separator } from "../components/ui/separator";
import { useStorefront } from "../context/StorefrontContext";
import type { Order, OrderSupportRequest } from "../types/storefront";
import { formatMoney } from "../utils/money";

type OrderPageProps = {
  orderId: string;
  onNavigate: (path: string) => void;
};

export function OrderPage({ orderId, onNavigate }: OrderPageProps) {
  const { getOrderSupportRequests, isBusy, loadOrder, submitOrderSupportRequest } = useStorefront();
  const [order, setOrder] = useState<Order | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [supportType, setSupportType] = useState<OrderSupportRequest["type"]>("support");
  const [supportMessage, setSupportMessage] = useState("");
  const currency = order?.currency_code || "USD";
  const supportRequests = getOrderSupportRequests(orderId);

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

  function handleSupportSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitOrderSupportRequest({
      order_id: orderId,
      type: supportType,
      message: supportMessage,
    });
    setSupportMessage("");
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Order</p>
        <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">
          {order?.display_id ? `Order #${order.display_id}` : "Order confirmation"}
        </h1>
        <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
          {order ? `Confirmation sent to ${order.email || "the checkout email"}.` : "Loading your order details."}
        </p>
      </div>

      <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <CheckCircle2 className="size-6" aria-hidden="true" />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Placed</p>
              <CardTitle className="text-2xl font-black text-emerald-950">{order?.id || orderId}</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          {order ? (
            <>
              <div className="grid gap-3 rounded-lg border border-emerald-100 bg-emerald-50/50 p-4">
                <h2 className="font-black text-emerald-950">Tracking</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    ["Placed", "Order received", CheckCircle2],
                    ["Processing", "Preparing shipment", Clock],
                    ["Delivery", "Carrier handoff", PackageCheck],
                  ].map(([title, text, Icon]) => (
                    <div key={title as string} className="flex items-center gap-3 rounded-lg border border-emerald-100 bg-white p-3">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <div>
                        <strong className="block text-emerald-950">{title as string}</strong>
                        <span className="text-sm font-bold text-emerald-700">{text as string}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

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

              <div className="grid gap-2">
                <h2 className="font-black text-emerald-950">Delivery</h2>
                {(order.shipping_methods ?? []).length > 0 ? (
                  order.shipping_methods?.map((method) => (
                    <p key={method.id} className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3 font-bold text-emerald-800">
                      {method.name || method.shipping_option_id || "Shipping method"} - {formatMoney(method.amount, currency)}
                    </p>
                  ))
                ) : (
                  <p className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/50 p-3 font-bold text-emerald-700">
                    No shipping method details returned.
                  </p>
                )}
              </div>

              <div className="grid gap-4 rounded-lg border border-emerald-100 p-4">
                <div>
                  <h2 className="font-black text-emerald-950">Order help</h2>
                  <p className="mt-1 text-sm font-semibold text-emerald-800/70">
                    Request cancellation, return, or general support. Requests are saved locally for this storefront flow.
                  </p>
                </div>
                <form className="grid gap-3" onSubmit={handleSupportSubmit}>
                  <div className="grid gap-2">
                    <Label htmlFor="support-type" className="font-black text-emerald-950">Request type</Label>
                    <select
                      id="support-type"
                      className="h-10 rounded-lg border border-emerald-200 bg-white px-3 font-bold text-emerald-950 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15"
                      value={supportType}
                      onChange={(event) => setSupportType(event.target.value as OrderSupportRequest["type"])}
                    >
                      <option value="support">Support question</option>
                      <option value="cancel">Cancel order</option>
                      <option value="return">Return item</option>
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="support-message" className="font-black text-emerald-950">Message</Label>
                    <textarea
                      id="support-message"
                      className="min-h-24 rounded-lg border border-emerald-200 px-3 py-2 font-bold outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15"
                      value={supportMessage}
                      onChange={(event) => setSupportMessage(event.target.value)}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="submit" className="h-10 bg-emerald-700 font-black text-white hover:bg-emerald-800">
                      {supportType === "return" ? <RotateCcw className="size-4" aria-hidden="true" /> : supportType === "cancel" ? <XCircle className="size-4" aria-hidden="true" /> : <PackageCheck className="size-4" aria-hidden="true" />}
                      <span>Submit request</span>
                    </Button>
                  </div>
                </form>

                {supportRequests.length > 0 ? (
                  <div className="grid gap-2">
                    {supportRequests.map((request) => (
                      <div key={request.id} className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="capitalize text-emerald-950">{request.type} request</strong>
                          <span className="rounded-full bg-white px-2 py-1 text-xs font-black uppercase text-emerald-700">{request.status}</span>
                        </div>
                        <p className="mt-2 font-semibold text-emerald-800/75">{request.message}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-emerald-700">
              <ShoppingBag className="size-8" aria-hidden="true" />
              <span className="font-bold">{isBusy || !hasLoaded ? "Loading order..." : "Order could not be loaded."}</span>
            </div>
          )}

          <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to="/" onNavigate={onNavigate}>
            Continue shopping
          </AppLink>
        </CardContent>
      </Card>
    </main>
  );
}
