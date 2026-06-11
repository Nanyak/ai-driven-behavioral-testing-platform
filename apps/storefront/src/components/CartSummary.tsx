import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
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
  onRemoveItem: (lineItemId: string) => void;
  onUpdateQuantity: (lineItemId: string, quantity: number) => void;
};

export function CartSummary({
  cart,
  shippingOptionCount,
  paymentProviderCount,
  checkoutResult,
  isBusy,
  onRemoveItem,
  onUpdateQuantity,
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

        <div className="grid min-h-32 gap-2 border-y border-emerald-100 py-4">
          {(cart?.items ?? []).length > 0 ? (
            cart?.items?.map((item) => (
              <div key={item.id} className="grid gap-3 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <span className="block truncate font-bold text-emerald-950">{item.title}</span>
                  <span className="text-sm font-semibold text-emerald-700">{formatMoney(item.unit_price, currency)} each</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" className="size-9 border-emerald-200 p-0 text-emerald-800 hover:bg-emerald-50" disabled={isBusy || item.quantity <= 1} onClick={() => onUpdateQuantity(item.id, item.quantity - 1)} aria-label={`Decrease ${item.title} quantity`}>
                    <Minus className="size-4" aria-hidden="true" />
                  </Button>
                  <strong className="flex h-9 min-w-10 items-center justify-center rounded-lg border border-emerald-200 bg-white px-2 text-emerald-900">{item.quantity}</strong>
                  <Button type="button" variant="outline" className="size-9 border-emerald-200 p-0 text-emerald-800 hover:bg-emerald-50" disabled={isBusy} onClick={() => onUpdateQuantity(item.id, item.quantity + 1)} aria-label={`Increase ${item.title} quantity`}>
                    <Plus className="size-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" className="size-9 border-red-200 p-0 text-red-700 hover:bg-red-50" disabled={isBusy} onClick={() => onRemoveItem(item.id)} aria-label={`Remove ${item.title}`}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
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
            <span>Discount</span>
            <strong>{formatMoney(cart?.discount_total, currency)}</strong>
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
