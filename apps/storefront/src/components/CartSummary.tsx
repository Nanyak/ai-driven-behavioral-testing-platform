import { CreditCard, RefreshCw, ShoppingCart } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Separator } from "./ui/separator";
import type { Cart } from "../types/storefront";
import { formatMoney } from "../utils/money";

type CartSummaryProps = {
  cart: Cart | null;
  shippingOptionCount: number;
  paymentProviderCount: number;
  checkoutResult: string;
  isBusy: boolean;
  onRefreshCart: () => void;
  onCheckout: () => void;
};

export function CartSummary({
  cart,
  shippingOptionCount,
  paymentProviderCount,
  checkoutResult,
  isBusy,
  onRefreshCart,
  onCheckout,
}: CartSummaryProps) {
  const currency = cart?.currency_code || "USD";

  return (
    <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5" aria-labelledby="cart-title">
      <CardHeader>
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Checkout</p>
        <CardTitle id="cart-title" className="text-2xl font-black text-emerald-950">
          Order summary
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="rounded-lg border border-emerald-100 bg-emerald-50/70 p-3 text-sm font-semibold leading-6 text-emerald-800 break-anywhere">
          {cart?.id || "Cart will be created on first add."}
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" onClick={onRefreshCart} disabled={isBusy || !cart?.id}>
            <RefreshCw className="size-4" aria-hidden="true" />
            <span>Check</span>
          </Button>
          <Button type="button" className="h-10 bg-orange-500 font-black text-white hover:bg-orange-600" onClick={onCheckout} disabled={isBusy}>
            <CreditCard className="size-4" aria-hidden="true" />
            <span>Checkout</span>
          </Button>
        </div>

        <div className="grid min-h-32 gap-2 border-y border-emerald-100 py-4">
          {(cart?.items ?? []).length > 0 ? (
            cart?.items?.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2">
                <span className="font-bold text-emerald-950">{item.title}</span>
                <strong className="text-emerald-800">x{item.quantity}</strong>
              </div>
            ))
          ) : (
            <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-emerald-700">
              <ShoppingCart className="size-7" aria-hidden="true" />
              <span className="font-bold">No items yet.</span>
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span>Subtotal</span>
            <strong>{formatMoney(cart?.subtotal, currency)}</strong>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Shipping</span>
            <strong>{formatMoney(cart?.shipping_total, currency)}</strong>
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-3 text-xl font-black text-emerald-950">
            <span>Total</span>
            <strong>{formatMoney(cart?.total, currency)}</strong>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 rounded-lg border border-emerald-100 bg-emerald-50/70 p-3">
          <Badge variant="outline" className="border-emerald-200 bg-white font-bold text-emerald-800">{shippingOptionCount} shipping options</Badge>
          <Badge variant="outline" className="border-emerald-200 bg-white font-bold text-emerald-800">{paymentProviderCount} payment providers</Badge>
          <Badge variant="outline" className="border-emerald-200 bg-white font-bold text-emerald-800">{cart?.shipping_methods?.length ?? 0} methods on cart</Badge>
          <Badge variant="outline" className="border-emerald-200 bg-white font-bold text-emerald-800">{cart?.payment_collection?.payment_sessions?.length ?? 0} payment sessions</Badge>
        </div>

        {checkoutResult ? (
          <p className="rounded-lg border border-orange-200 bg-orange-50 p-3 font-black leading-6 text-orange-800">{checkoutResult}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
