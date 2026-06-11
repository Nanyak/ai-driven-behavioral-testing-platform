import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CreditCard, RotateCcw, Save, ShieldCheck, Tag, Truck } from "lucide-react";
import { AppLink } from "../components/AppLink";
import { CartSummary } from "../components/CartSummary";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useStorefront } from "../context/StorefrontContext";
import { formatMoney } from "../utils/money";

type CartPageProps = {
  onNavigate: (path: string) => void;
};

export function CartPage({ onNavigate }: CartPageProps) {
  const {
    cart,
    checkoutResult,
    customer,
    isBusy,
    applyPromoCode,
    paymentProviders,
    prepareCheckout,
    removeCartItem,
    runCheckout,
    saveAddress,
    savedAddresses,
    shippingOptions,
    updateCartItemQuantity,
  } = useStorefront();
  const [email, setEmail] = useState(customer?.email ?? "");
  const [firstName, setFirstName] = useState(customer?.first_name ?? "Behavior");
  const [lastName, setLastName] = useState(customer?.last_name ?? "Shopper");
  const [address1, setAddress1] = useState("Test Street 1");
  const [city, setCity] = useState("Copenhagen");
  const [postalCode, setPostalCode] = useState("1000");
  const [countryCode, setCountryCode] = useState("dk");
  const [phone, setPhone] = useState("12345678");
  const [addressLabel, setAddressLabel] = useState("Home");
  const [promoCode, setPromoCode] = useState("");
  const [selectedShippingOptionId, setSelectedShippingOptionId] = useState("");
  const [selectedPaymentProviderId, setSelectedPaymentProviderId] = useState("");

  const currency = cart?.currency_code || "USD";
  const canPlaceOrder = Boolean(cart?.items?.length && selectedShippingOptionId && selectedPaymentProviderId);

  const checkoutAddress = useMemo(
    () => ({
      email,
      first_name: firstName,
      last_name: lastName,
      address_1: address1,
      city,
      postal_code: postalCode,
      country_code: countryCode.toLowerCase(),
      phone,
    }),
    [address1, city, countryCode, email, firstName, lastName, phone, postalCode]
  );

  useEffect(() => {
    setSelectedShippingOptionId((current) => (
      current && shippingOptions.some((option) => option.id === current) ? current : shippingOptions[0]?.id || ""
    ));
  }, [shippingOptions]);

  useEffect(() => {
    setSelectedPaymentProviderId((current) => (
      current && paymentProviders.some((provider) => provider.id === current) ? current : paymentProviders[0]?.id || ""
    ));
  }, [paymentProviders]);

  async function handlePrepareCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await prepareCheckout(checkoutAddress);
  }

  function applySavedAddress(addressId: string) {
    const address = savedAddresses.find((savedAddress) => savedAddress.id === addressId);
    if (!address) {
      return;
    }

    setEmail(address.email);
    setFirstName(address.first_name);
    setLastName(address.last_name);
    setAddress1(address.address_1);
    setCity(address.city);
    setPostalCode(address.postal_code);
    setCountryCode(address.country_code);
    setPhone(address.phone);
    setAddressLabel(address.label || "Saved address");
  }

  function handleSaveAddress() {
    saveAddress({
      ...checkoutAddress,
      label: addressLabel,
    });
  }

  async function handleApplyPromo() {
    await applyPromoCode(promoCode);
  }

  async function handlePlaceOrder() {
    const orderId = await runCheckout(selectedShippingOptionId, selectedPaymentProviderId);
    if (orderId) {
      onNavigate(`/orders/${encodeURIComponent(orderId)}`);
    }
  }

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-14 md:px-6">
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-widest text-emerald-600">Cart</p>
        <h1 className="text-4xl font-black tracking-tight text-slate-900 md:text-6xl">Your shopping cart</h1>
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
          onRemoveItem={removeCartItem}
          onUpdateQuantity={updateCartItemQuantity}
        />
        <Card className="h-fit rounded-2xl border-slate-100 bg-white shadow-xl shadow-slate-900/5 lg:sticky lg:top-28">
          <CardContent className="grid gap-5 p-5">
            <h2 className="text-2xl font-black text-slate-900">Checkout</h2>
            <div className="grid gap-2 rounded-lg border border-slate-100 bg-emerald-50/60 p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-5 text-emerald-600" aria-hidden="true" />
                <div>
                  <strong className="block text-sm text-slate-900">Protected checkout</strong>
                  <span className="text-xs font-bold text-emerald-700">Delivery, payment, and support are confirmed before order placement.</span>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <span className="flex items-center gap-2 text-xs font-black text-emerald-800"><Truck className="size-4" aria-hidden="true" /> Delivery options</span>
                <span className="flex items-center gap-2 text-xs font-black text-emerald-800"><RotateCcw className="size-4" aria-hidden="true" /> Return requests</span>
              </div>
            </div>
            {savedAddresses.length > 0 ? (
              <div className="grid gap-2 rounded-lg border border-slate-100 bg-emerald-50/60 p-3">
                <Label htmlFor="saved-addresses" className="font-black text-slate-900">Saved address</Label>
                <select
                  id="saved-addresses"
                  className="h-10 rounded-lg border border-emerald-200 bg-white px-3 font-bold text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15"
                  defaultValue=""
                  onChange={(event) => applySavedAddress(event.target.value)}
                >
                  <option value="" disabled>Choose address</option>
                  {savedAddresses.map((address) => (
                    <option key={address.id} value={address.id}>
                      {address.label || address.address_1} - {address.city}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <form className="grid gap-3" onSubmit={handlePrepareCheckout}>
              <div className="grid gap-2">
                <Label htmlFor="checkout-address-label" className="font-black text-slate-900">Address label</Label>
                <Input id="checkout-address-label" value={addressLabel} onChange={(event) => setAddressLabel(event.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="checkout-email" className="font-black text-slate-900">Email</Label>
                <Input id="checkout-email" value={email} onChange={(event) => setEmail(event.target.value)} required type="email" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="checkout-first-name" className="font-black text-slate-900">First name</Label>
                  <Input id="checkout-first-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="checkout-last-name" className="font-black text-slate-900">Last name</Label>
                  <Input id="checkout-last-name" value={lastName} onChange={(event) => setLastName(event.target.value)} required />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="checkout-address" className="font-black text-slate-900">Address</Label>
                <Input id="checkout-address" value={address1} onChange={(event) => setAddress1(event.target.value)} required />
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
                <div className="grid gap-2">
                  <Label htmlFor="checkout-city" className="font-black text-slate-900">City</Label>
                  <Input id="checkout-city" value={city} onChange={(event) => setCity(event.target.value)} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="checkout-postal" className="font-black text-slate-900">Postal</Label>
                  <Input id="checkout-postal" value={postalCode} onChange={(event) => setPostalCode(event.target.value)} required />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[100px_1fr]">
                <div className="grid gap-2">
                  <Label htmlFor="checkout-country" className="font-black text-slate-900">Country</Label>
                  <Input id="checkout-country" value={countryCode} onChange={(event) => setCountryCode(event.target.value)} required maxLength={2} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="checkout-phone" className="font-black text-slate-900">Phone</Label>
                  <Input id="checkout-phone" value={phone} onChange={(event) => setPhone(event.target.value)} required />
                </div>
              </div>
              <Button type="submit" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" disabled={isBusy || !cart?.items?.length}>
                <Truck className="size-4" aria-hidden="true" />
                <span>Get delivery options</span>
              </Button>
              <Button type="button" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" disabled={isBusy} onClick={handleSaveAddress}>
                <Save className="size-4" aria-hidden="true" />
                <span>Save address</span>
              </Button>
            </form>

            <div className="grid gap-3 border-t border-slate-100 pt-5">
              <h3 className="font-black text-slate-900">Promo code</h3>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input value={promoCode} onChange={(event) => setPromoCode(event.target.value)} placeholder="Enter voucher or promo code" />
                <Button type="button" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" disabled={isBusy || !cart?.id} onClick={handleApplyPromo}>
                  <Tag className="size-4" aria-hidden="true" />
                  <span>Apply</span>
                </Button>
              </div>
            </div>

            <div className="grid gap-3 border-t border-slate-100 pt-5">
              <h3 className="font-black text-slate-900">Shipping option</h3>
              {shippingOptions.length > 0 ? shippingOptions.map((option) => (
                <label key={option.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-100 bg-emerald-50/50 p-3 font-bold text-emerald-900">
                  <span className="flex min-w-0 items-center gap-2">
                    <input type="radio" name="shipping-option" value={option.id} checked={selectedShippingOptionId === option.id} onChange={() => setSelectedShippingOptionId(option.id)} />
                    <span className="truncate">{option.name}</span>
                  </span>
                  <strong>{formatMoney(option.amount, currency)}</strong>
                </label>
              )) : (
                <p className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/50 p-3 text-sm font-bold text-emerald-700">
                  Enter address details to load delivery options.
                </p>
              )}
            </div>

            <div className="grid gap-3 border-t border-slate-100 pt-5">
              <h3 className="font-black text-slate-900">Payment type</h3>
              {paymentProviders.length > 0 ? paymentProviders.map((provider) => (
                <label key={provider.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-100 bg-emerald-50/50 p-3 font-bold text-emerald-900">
                  <input type="radio" name="payment-provider" value={provider.id} checked={selectedPaymentProviderId === provider.id} onChange={() => setSelectedPaymentProviderId(provider.id)} />
                  <span>{provider.id.replace(/^pp_/, "").replace(/_/g, " ")}</span>
                </label>
              )) : (
                <p className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/50 p-3 text-sm font-bold text-emerald-700">
                  Payment types appear after delivery options are loaded.
                </p>
              )}
            </div>

            <Button type="button" className="h-11 bg-orange-500 font-black text-white hover:bg-orange-600" onClick={handlePlaceOrder} disabled={isBusy || !canPlaceOrder}>
              <CreditCard className="size-4" aria-hidden="true" />
              <span>Place order</span>
            </Button>
            <AppLink className={buttonVariants({ variant: "outline", className: "h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" })} to="/" onNavigate={onNavigate}>
              Continue shopping
            </AppLink>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
