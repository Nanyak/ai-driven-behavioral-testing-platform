import { AppLink } from "../components/AppLink";
import { CartSummary } from "../components/CartSummary";
import { buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";

type CartPageProps = {
  onNavigate: (path: string) => void;
};

export function CartPage({ onNavigate }: CartPageProps) {
  const {
    cart,
    checkoutResult,
    isBusy,
    paymentProviders,
    refreshCartCheck,
    runCheckout,
    shippingOptions,
  } = useStorefront();

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Cart</p>
        <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">Your shopping cart</h1>
        <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
          Review line items, validate shipping and payment availability, then complete checkout.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <CartSummary
          cart={cart}
          shippingOptionCount={shippingOptions.length}
          paymentProviderCount={paymentProviders.length}
          checkoutResult={checkoutResult}
          isBusy={isBusy}
          onRefreshCart={refreshCartCheck}
          onCheckout={runCheckout}
        />
        <Card className="h-fit rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5 lg:sticky lg:top-28">
          <CardContent className="grid gap-4 p-5">
            <h2 className="text-2xl font-black text-emerald-950">Checkout details</h2>
            <p className="font-semibold leading-7 text-emerald-900/70">
              This storefront uses the configured Medusa region, shipping option, and payment provider
              to exercise a realistic ecommerce checkout flow.
            </p>
            <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to="/" onNavigate={onNavigate}>
              Continue shopping
            </AppLink>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
