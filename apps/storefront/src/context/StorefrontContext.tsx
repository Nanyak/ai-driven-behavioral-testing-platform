import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearCustomerToken, getCustomerToken, setCustomerToken } from "../services/authToken";
import { medusaStore } from "../services/medusa";
import type { Cart, Customer, PaymentProvider, Product, ShippingOption, Variant } from "../types/storefront";

type StorefrontContextValue = {
  authEmail: string;
  authPassword: string;
  cart: Cart | null;
  checkoutResult: string;
  customer: Customer | null;
  isBusy: boolean;
  itemCount: number;
  paymentProviders: PaymentProvider[];
  products: Product[];
  selectedVariantId: string;
  shippingOptions: ShippingOption[];
  status: string;
  addVariantToCart: (variantId: string) => Promise<void>;
  getProduct: (productId: string) => Product | undefined;
  getSelectedVariant: (product?: Product) => Variant | undefined;
  loadProducts: () => Promise<void>;
  loginCustomer: () => Promise<boolean>;
  logoutCustomer: () => void;
  refreshCartCheck: () => Promise<void>;
  registerCustomer: () => Promise<boolean>;
  runCheckout: () => Promise<void>;
  setAuthEmail: (value: string) => void;
  setAuthPassword: (value: string) => void;
  setSelectedVariantId: (value: string) => void;
};

const StorefrontContext = createContext<StorefrontContextValue | null>(null);

type StorefrontProviderProps = {
  children: ReactNode;
};

export function StorefrontProvider({ children }: StorefrontProviderProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [cart, setCart] = useState<Cart | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [shippingOptions, setShippingOptions] = useState<ShippingOption[]>([]);
  const [paymentProviders, setPaymentProviders] = useState<PaymentProvider[]>([]);
  const [checkoutResult, setCheckoutResult] = useState("");
  const [status, setStatus] = useState("Loading products");
  const [isBusy, setIsBusy] = useState(false);

  const itemCount = useMemo(
    () => cart?.items?.reduce((total, item) => total + item.quantity, 0) ?? 0,
    [cart]
  );

  function getProduct(productId: string) {
    return products.find((product) => product.id === productId);
  }

  function getSelectedVariant(product?: Product) {
    return product?.variants?.find((variant) => variant.id === selectedVariantId) ?? product?.variants?.[0];
  }

  async function loadProducts() {
    setIsBusy(true);
    setStatus("Loading products");
    try {
      const nextProducts = await medusaStore.listProducts();
      setProducts(nextProducts);
      setSelectedVariantId((current) => current || nextProducts[0]?.variants?.[0]?.id || "");
      setStatus(`${nextProducts.length} products available`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load products");
    } finally {
      setIsBusy(false);
    }
  }

  async function registerCustomer() {
    setIsBusy(true);
    setStatus("Creating customer account");
    try {
      const { token, customer: createdCustomer } = await medusaStore.registerCustomer(authEmail, authPassword);
      setCustomerToken(token);
      setCustomer(createdCustomer);
      setStatus("Customer account ready");
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create customer account");
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function loginCustomer() {
    setIsBusy(true);
    setStatus("Signing in customer");
    try {
      const { token, customer: profile } = await medusaStore.loginCustomer(authEmail, authPassword);
      setCustomerToken(token);
      setCustomer(profile);
      setStatus("Customer signed in");
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not sign in");
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function loadCustomer() {
    if (!getCustomerToken()) {
      return;
    }

    try {
      const profile = await medusaStore.getCustomer();
      setCustomer(profile);
    } catch {
      clearCustomerToken();
      setCustomer(null);
    }
  }

  function logoutCustomer() {
    clearCustomerToken();
    setCustomer(null);
    setStatus("Customer signed out");
  }

  async function ensureCart() {
    if (cart?.id) {
      return cart;
    }

    const createdCart = await medusaStore.createCart();
    setCart(createdCart);
    return createdCart;
  }

  async function addVariantToCart(variantId: string) {
    if (!variantId) {
      setStatus("Select a product variant first");
      return;
    }

    setIsBusy(true);
    try {
      const activeCart = await ensureCart();
      const updatedCart = await medusaStore.addLineItem(activeCart.id, variantId);
      setCart(updatedCart);
      setStatus("Cart updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update cart");
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshCartCheck() {
    if (!cart?.id) {
      setStatus("Create a cart first");
      return;
    }

    setIsBusy(true);
    try {
      const latestCart = await medusaStore.getCart(cart.id);
      const [options, providers] = await Promise.all([
        medusaStore.getShippingOptions(cart.id),
        latestCart.region_id ? medusaStore.getPaymentProviders(latestCart.region_id) : Promise.resolve([]),
      ]);
      setCart(latestCart);
      setShippingOptions(options);
      setPaymentProviders(providers);
      setStatus("Cart checked");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not check cart");
    } finally {
      setIsBusy(false);
    }
  }

  async function runCheckout() {
    setIsBusy(true);
    setCheckoutResult("Preparing checkout");
    try {
      let activeCart = await ensureCart();

      if ((activeCart.items ?? []).length === 0) {
        const fallbackVariantId = selectedVariantId || products[0]?.variants?.[0]?.id;
        if (fallbackVariantId) {
          activeCart = await medusaStore.addLineItem(activeCart.id, fallbackVariantId);
        }
      }

      activeCart = await medusaStore.updateCheckoutAddress(
        activeCart.id,
        customer?.email || authEmail,
        customer?.first_name || "Behavior",
        customer?.last_name || "Shopper"
      );

      const options = await medusaStore.getShippingOptions(activeCart.id);
      setShippingOptions(options);
      const option = options[0];
      if (!option?.id) {
        throw new Error("No shipping option is available for this cart.");
      }

      activeCart = await medusaStore.addShippingMethod(activeCart.id, option.id);

      const providers = await medusaStore.getPaymentProviders(activeCart.region_id ?? "");
      setPaymentProviders(providers);
      const provider = providers[0];
      if (!provider?.id) {
        throw new Error("No payment provider is available for this cart region.");
      }

      const paymentCollection = await medusaStore.createPaymentCollection(activeCart.id);
      activeCart = {
        ...activeCart,
        payment_collection: paymentCollection,
      };

      const collectionId = activeCart.payment_collection?.id;
      if (!collectionId) {
        throw new Error("Cart does not have a payment collection yet.");
      }

      const payment = await medusaStore.createPaymentSession(collectionId, provider.id);
      activeCart = {
        ...activeCart,
        payment_collection: payment,
      };

      const completed = await medusaStore.completeCart(activeCart.id);

      if (completed.type === "order" && completed.order?.id) {
        setCheckoutResult(`Checkout complete: ${completed.order.id}`);
        setStatus("Checkout completed");
      } else {
        setCheckoutResult(completed.error?.message || "Checkout returned the cart for more action.");
        if (completed.cart) {
          setCart(completed.cart);
        }
      }
    } catch (error) {
      setCheckoutResult(error instanceof Error ? error.message : "Checkout failed");
      setStatus(error instanceof Error ? error.message : "Checkout failed");
    } finally {
      setIsBusy(false);
    }
  }

  useEffect(() => {
    void loadProducts();
    void loadCustomer();
  }, []);

  const value = useMemo<StorefrontContextValue>(
    () => ({
      authEmail,
      authPassword,
      cart,
      checkoutResult,
      customer,
      isBusy,
      itemCount,
      paymentProviders,
      products,
      selectedVariantId,
      shippingOptions,
      status,
      addVariantToCart,
      getProduct,
      getSelectedVariant,
      loadProducts,
      loginCustomer,
      logoutCustomer,
      refreshCartCheck,
      registerCustomer,
      runCheckout,
      setAuthEmail,
      setAuthPassword,
      setSelectedVariantId,
    }),
    [
      authEmail,
      authPassword,
      cart,
      checkoutResult,
      customer,
      isBusy,
      itemCount,
      paymentProviders,
      products,
      selectedVariantId,
      shippingOptions,
      status,
    ]
  );

  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>;
}

export function useStorefront() {
  const context = useContext(StorefrontContext);

  if (!context) {
    throw new Error("useStorefront must be used inside StorefrontProvider");
  }

  return context;
}
