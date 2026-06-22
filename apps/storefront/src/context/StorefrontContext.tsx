import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearCustomerToken, getCustomerToken, setCustomerToken } from "../services/authToken";
import { medusaStore } from "../services/medusa";
import type { Cart, CheckoutAddress, Customer, Order, PaymentProvider, Product, ProductQuestion, ProductReview, ShippingOption, StoreNotification, Variant } from "../types/storefront";

type StorefrontContextValue = {
  authEmail: string;
  authPassword: string;
  cart: Cart | null;
  checkoutResult: string;
  customer: Customer | null;
  isBusy: boolean;
  itemCount: number;
  notifications: StoreNotification[];
  unreadNotificationCount: number;
  paymentProviders: PaymentProvider[];
  products: Product[];
  productQuestions: ProductQuestion[];
  productReviews: ProductReview[];
  recentOrderIds: string[];
  recentlyViewedProductIds: string[];
  savedAddresses: CheckoutAddress[];
  searchQuery: string;
  selectedVariantId: string;
  shippingOptions: ShippingOption[];
  status: string;
  addVariantToCart: (variantId: string) => Promise<void>;
  applyPromoCode: (promoCode: string) => Promise<void>;
  getProductReviews: (productId: string) => ProductReview[];
  getProductQuestions: (productId: string) => ProductQuestion[];
  getProduct: (productId: string) => Product | undefined;
  getSelectedVariant: (product?: Product) => Variant | undefined;
  hasPurchasedProduct: (productId: string) => boolean;
  isWishlisted: (productId: string) => boolean;
  loadOrder: (orderId: string) => Promise<Order | null>;
  loadOrders: () => Promise<Order[]>;
  loadProduct: (productId: string) => Promise<void>;
  loadProducts: () => Promise<void>;
  loginCustomer: () => Promise<boolean>;
  logoutCustomer: () => void;
  markAllNotificationsRead: () => void;
  prepareCheckout: (address: CheckoutAddress) => Promise<boolean>;
  removeCartItem: (lineItemId: string) => Promise<void>;
  registerCustomer: () => Promise<boolean>;
  rememberViewedProduct: (productId: string) => void;
  runCheckout: (shippingOptionId: string, paymentProviderId: string) => Promise<string | null>;
  saveAddress: (address: CheckoutAddress) => void;
  submitProductQuestion: (question: Omit<ProductQuestion, "id" | "created_at" | "answer">) => void;
  submitReview: (review: Omit<ProductReview, "id" | "created_at">) => void;
  setAuthEmail: (value: string) => void;
  setAuthPassword: (value: string) => void;
  setSearchQuery: (value: string) => void;
  setSelectedVariantId: (value: string) => void;
  toggleWishlist: (productId: string) => void;
  updateCartItemQuantity: (lineItemId: string, quantity: number) => Promise<void>;
  wishlistProductIds: string[];
};

const StorefrontContext = createContext<StorefrontContextValue | null>(null);
const wishlistStorageKey = "behavior-storefront-wishlist";
const recentOrderStorageKey = "behavior-storefront-orders";
const addressStorageKey = "behavior-storefront-addresses";
const reviewStorageKey = "behavior-storefront-reviews";
const recentlyViewedStorageKey = "behavior-storefront-recently-viewed";
const notificationStorageKey = "behavior-storefront-notifications";
const questionStorageKey = "behavior-storefront-questions";
const purchasedVariantsStorageKey = "behavior-storefront-purchased-variants";

type StorefrontProviderProps = {
  children: ReactNode;
};

export function StorefrontProvider({ children }: StorefrontProviderProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [wishlistProductIds, setWishlistProductIds] = useState<string[]>(() => readStoredList(wishlistStorageKey));
  const [recentOrderIds, setRecentOrderIds] = useState<string[]>(() => readStoredList(recentOrderStorageKey));
  const [purchasedVariantIds, setPurchasedVariantIds] = useState<string[]>(() => readStoredList(purchasedVariantsStorageKey));
  const [recentlyViewedProductIds, setRecentlyViewedProductIds] = useState<string[]>(() => readStoredList(recentlyViewedStorageKey));
  const [savedAddresses, setSavedAddresses] = useState<CheckoutAddress[]>(() => readStoredAddresses());
  const [productReviews, setProductReviews] = useState<ProductReview[]>(() => readStoredReviews());
  const [productQuestions, setProductQuestions] = useState<ProductQuestion[]>(() => readStoredQuestions());
  const [notifications, setNotifications] = useState<StoreNotification[]>(() => readStoredNotifications());
  const [searchQuery, setSearchQuery] = useState("");
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
  const unreadNotificationCount = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications]
  );

  function addNotification(notification: Omit<StoreNotification, "id" | "created_at" | "read">) {
    setNotifications((current) => {
      const next = [{
        ...notification,
        id: `note_${Date.now()}`,
        read: false,
        created_at: new Date().toISOString(),
      }, ...current].slice(0, 50);
      writeStoredNotifications(next);
      return next;
    });
  }

  function markAllNotificationsRead() {
    setNotifications((current) => {
      const next = current.map((notification) => ({ ...notification, read: true }));
      writeStoredNotifications(next);
      return next;
    });
  }

  function getProduct(productId: string) {
    return products.find((product) => product.id === productId);
  }

  function getSelectedVariant(product?: Product) {
    return product?.variants?.find((variant) => variant.id === selectedVariantId) ?? product?.variants?.[0];
  }

  function isWishlisted(productId: string) {
    return wishlistProductIds.includes(productId);
  }

  function hasPurchasedProduct(productId: string) {
    const product = products.find((p) => p.id === productId);
    return (product?.variants ?? []).some((v) => purchasedVariantIds.includes(v.id));
  }

  function getProductReviews(productId: string) {
    return productReviews.filter((review) => review.product_id === productId);
  }

  function getProductQuestions(productId: string) {
    return productQuestions.filter((question) => question.product_id === productId);
  }

  function toggleWishlist(productId: string) {
    if (!productId) {
      return;
    }

    setWishlistProductIds((current) => {
      const next = current.includes(productId)
        ? current.filter((currentProductId) => currentProductId !== productId)
        : [productId, ...current];
      writeStoredList(wishlistStorageKey, next);
      setStatus(next.includes(productId) ? "Saved to wishlist" : "Removed from wishlist");
      addNotification({
        title: next.includes(productId) ? "Product saved" : "Product unsaved",
        body: "Your saved product list was updated.",
        type: "account",
      });
      return next;
    });
  }

  function rememberOrder(orderId: string) {
    setRecentOrderIds((current) => {
      const next = [orderId, ...current.filter((currentOrderId) => currentOrderId !== orderId)].slice(0, 20);
      writeStoredList(recentOrderStorageKey, next);
      return next;
    });
  }

  function rememberViewedProduct(productId: string) {
    if (!productId) {
      return;
    }

    setRecentlyViewedProductIds((current) => {
      const next = [productId, ...current.filter((currentProductId) => currentProductId !== productId)].slice(0, 12);
      writeStoredList(recentlyViewedStorageKey, next);
      return next;
    });
  }

  function saveAddress(address: CheckoutAddress) {
    const addressId = address.id || `addr_${Date.now()}`;
    setSavedAddresses((current) => {
      const nextAddress = {
        ...address,
        id: addressId,
        label: address.label || `${address.city}, ${address.country_code.toUpperCase()}`,
      };
      const next = [nextAddress, ...current.filter((currentAddress) => currentAddress.id !== addressId)].slice(0, 6);
      writeStoredAddresses(next);
      setStatus("Address saved");
      addNotification({
        title: "Address saved",
        body: `${nextAddress.label} is ready for checkout.`,
        type: "account",
      });
      return next;
    });
  }

  function submitReview(review: Omit<ProductReview, "id" | "created_at">) {
    const nextReview: ProductReview = {
      ...review,
      id: `review_${Date.now()}`,
      created_at: new Date().toISOString(),
      rating: Math.max(1, Math.min(5, review.rating)),
    };

    setProductReviews((current) => {
      const next = [nextReview, ...current].slice(0, 100);
      writeStoredReviews(next);
      setStatus("Review submitted");
      addNotification({
        title: "Review submitted",
        body: "Thanks for sharing product feedback.",
        type: "account",
      });
      return next;
    });
  }

  function submitProductQuestion(question: Omit<ProductQuestion, "id" | "created_at" | "answer">) {
    const nextQuestion: ProductQuestion = {
      ...question,
      id: `question_${Date.now()}`,
      created_at: new Date().toISOString(),
    };

    setProductQuestions((current) => {
      const next = [nextQuestion, ...current].slice(0, 100);
      writeStoredQuestions(next);
      setStatus("Question submitted");
      addNotification({
        title: "Question submitted",
        body: "Your product question was added to the Q&A.",
        type: "account",
      });
      return next;
    });
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

  async function loadProduct(productId: string) {
    try {
      const product = await medusaStore.getProductById(productId);
      setProducts((current) =>
        current.some((existing) => existing.id === product.id)
          ? current.map((existing) => (existing.id === product.id ? product : existing))
          : [...current, product]
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load product");
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

    // Cart and checkout require a signed-in customer (enforced by the API gate).
    // Gate at the UI too: send a logged-out shopper to sign in rather than firing
    // a doomed POST /store/carts that 401s.
    if (!getCustomerToken()) {
      setStatus("Please sign in to add items to your cart");
      window.history.pushState({}, "", "/signin");
      window.dispatchEvent(new Event("storefront:navigation"));
      return;
    }

    setIsBusy(true);
    try {
      const activeCart = await ensureCart();
      const updatedCart = await medusaStore.addLineItem(activeCart.id, variantId);
      setCart(updatedCart);
      setShippingOptions([]);
      setPaymentProviders([]);
      setStatus("Cart updated");
      addNotification({
        title: "Cart updated",
        body: "A product was added to your cart.",
        type: "cart",
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update cart");
    } finally {
      setIsBusy(false);
    }
  }

  async function updateCartItemQuantity(lineItemId: string, quantity: number) {
    if (!cart?.id) {
      setStatus("Create a cart first");
      return;
    }

    const nextQuantity = Math.max(1, quantity);
    setIsBusy(true);
    try {
      const updatedCart = await medusaStore.updateLineItem(cart.id, lineItemId, nextQuantity);
      setCart(updatedCart);
      setShippingOptions([]);
      setPaymentProviders([]);
      setStatus("Cart quantity updated");
      addNotification({
        title: "Quantity changed",
        body: "Your cart totals may have changed.",
        type: "cart",
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update quantity");
    } finally {
      setIsBusy(false);
    }
  }

  async function removeCartItem(lineItemId: string) {
    if (!cart?.id) {
      setStatus("Create a cart first");
      return;
    }

    setIsBusy(true);
    try {
      const updatedCart = await medusaStore.deleteLineItem(cart.id, lineItemId);
      setCart(updatedCart);
      setShippingOptions([]);
      setPaymentProviders([]);
      setStatus("Item removed from cart");
      addNotification({
        title: "Item removed",
        body: "A product was removed from your cart.",
        type: "cart",
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not remove item");
    } finally {
      setIsBusy(false);
    }
  }

  async function prepareCheckout(address: CheckoutAddress) {
    if (!cart?.id) {
      setStatus("Create a cart first");
      return false;
    }

    setIsBusy(true);
    try {
      const addressedCart = await medusaStore.updateCheckoutAddress(cart.id, address);
      const [options, providers] = await Promise.all([
        medusaStore.getShippingOptions(addressedCart.id),
        addressedCart.region_id ? medusaStore.getPaymentProviders(addressedCart.region_id) : Promise.resolve([]),
      ]);
      setCart(addressedCart);
      setShippingOptions(options);
      setPaymentProviders(providers);
      setStatus("Checkout options ready");
      addNotification({
        title: "Checkout ready",
        body: "Shipping and payment options are available.",
        type: "order",
      });
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not prepare checkout");
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function applyPromoCode(promoCode: string) {
    if (!cart?.id) {
      setStatus("Create a cart first");
      return;
    }

    setIsBusy(true);
    try {
      const updatedCart = await medusaStore.applyPromoCode(cart.id, promoCode.trim());
      setCart(updatedCart);
      setShippingOptions([]);
      setPaymentProviders([]);
      setStatus(promoCode.trim() ? "Promo code applied" : "Promo code cleared");
      addNotification({
        title: promoCode.trim() ? "Promo applied" : "Promo cleared",
        body: "Cart discounts were recalculated.",
        type: "promo",
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not apply promo code");
    } finally {
      setIsBusy(false);
    }
  }

  async function runCheckout(shippingOptionId: string, paymentProviderId: string) {
    setIsBusy(true);
    setCheckoutResult("Placing order");
    try {
      let activeCart = await ensureCart();

      if ((activeCart.items ?? []).length === 0) {
        throw new Error("Add at least one item before checkout.");
      }

      if (!shippingOptionId) {
        throw new Error("Choose a shipping option before placing the order.");
      }

      if (!paymentProviderId) {
        throw new Error("Choose a payment type before placing the order.");
      }

      activeCart = await medusaStore.addShippingMethod(activeCart.id, shippingOptionId);
      const paymentCollection = activeCart.payment_collection ?? await medusaStore.createPaymentCollection(activeCart.id);
      activeCart = {
        ...activeCart,
        payment_collection: paymentCollection,
      };

      const collectionId = activeCart.payment_collection?.id;
      if (!collectionId) {
        throw new Error("Cart does not have a payment collection yet.");
      }

      const payment = await medusaStore.createPaymentSession(collectionId, paymentProviderId);
      activeCart = {
        ...activeCart,
        payment_collection: payment,
      };

      const completed = await medusaStore.completeCart(activeCart.id);

      if (completed.type === "order" && completed.order?.id) {
        setCheckoutResult(`Checkout complete: ${completed.order.id}`);
        setStatus("Checkout completed");
        rememberOrder(completed.order.id);
        addNotification({
          title: "Order placed",
          body: `Order ${completed.order.id} is confirmed.`,
          type: "order",
        });

        const boughtIds = (activeCart.items ?? [])
          .map((item) => item.variant_id)
          .filter((id): id is string => Boolean(id));
        if (boughtIds.length > 0) {
          setPurchasedVariantIds((prev) => {
            const next = Array.from(new Set([...prev, ...boughtIds]));
            writeStoredList(purchasedVariantsStorageKey, next);
            return next;
          });
        }

        setCart(null);
        setShippingOptions([]);
        setPaymentProviders([]);
        return completed.order.id;
      } else {
        setCheckoutResult(completed.error?.message || "Checkout returned the cart for more action.");
        if (completed.cart) {
          setCart(completed.cart);
        }
        return null;
      }
    } catch (error) {
      setCheckoutResult(error instanceof Error ? error.message : "Checkout failed");
      setStatus(error instanceof Error ? error.message : "Checkout failed");
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function loadOrder(orderId: string) {
    setIsBusy(true);
    setStatus("Loading order");
    try {
      const order = await medusaStore.getOrder(orderId);
      setStatus(`Order ${order.display_id ? `#${order.display_id}` : order.id} loaded`);
      return order;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load order");
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function loadOrders() {
    setIsBusy(true);
    setStatus("Loading orders");
    try {
      const authenticatedOrders = getCustomerToken() ? await medusaStore.listOrders() : [];
      const knownOrderIds = new Set(authenticatedOrders.map((order) => order.id));
      const guestOrders = await Promise.all(
        recentOrderIds
          .filter((orderId) => !knownOrderIds.has(orderId))
          .map(async (orderId) => {
            try {
              return await medusaStore.getOrder(orderId);
            } catch {
              return null;
            }
          })
      );
      const orders = [...authenticatedOrders, ...guestOrders.filter((order): order is Order => Boolean(order))];
      setStatus(`${orders.length} orders loaded`);
      return orders;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load orders");
      return [];
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
      notifications,
      unreadNotificationCount,
      paymentProviders,
      products,
      productQuestions,
      productReviews,
      recentOrderIds,
      recentlyViewedProductIds,
      savedAddresses,
      searchQuery,
      selectedVariantId,
      shippingOptions,
      status,
      addVariantToCart,
      applyPromoCode,
      getProductReviews,
      getProductQuestions,
      getProduct,
      getSelectedVariant,
      hasPurchasedProduct,
      isWishlisted,
      loadOrder,
      loadOrders,
      loadProduct,
      loadProducts,
      loginCustomer,
      logoutCustomer,
      markAllNotificationsRead,
      prepareCheckout,
      removeCartItem,
      registerCustomer,
      rememberViewedProduct,
      runCheckout,
      saveAddress,
      setAuthEmail,
      setAuthPassword,
      setSearchQuery,
      setSelectedVariantId,
      submitProductQuestion,
      submitReview,
      toggleWishlist,
      updateCartItemQuantity,
      wishlistProductIds,
    }),
    [
      authEmail,
      authPassword,
      cart,
      checkoutResult,
      customer,
      isBusy,
      itemCount,
      notifications,
      paymentProviders,
      products,
      productQuestions,
      productReviews,
      purchasedVariantIds,
      recentOrderIds,
      recentlyViewedProductIds,
      savedAddresses,
      searchQuery,
      selectedVariantId,
      shippingOptions,
      status,
      wishlistProductIds,
    ]
  );

  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>;
}

function readStoredNotifications() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(notificationStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isStoreNotification) : [];
  } catch {
    return [];
  }
}

function writeStoredNotifications(notifications: StoreNotification[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(notificationStorageKey, JSON.stringify(notifications));
}

function isStoreNotification(value: unknown): value is StoreNotification {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoreNotification>;
  return Boolean(candidate.id && candidate.title && candidate.body && candidate.type && candidate.created_at && typeof candidate.read === "boolean");
}

function readStoredList(key: string) {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function writeStoredList(key: string, values: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(values));
}

function readStoredAddresses() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(addressStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isCheckoutAddress) : [];
  } catch {
    return [];
  }
}

function writeStoredAddresses(addresses: CheckoutAddress[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(addressStorageKey, JSON.stringify(addresses));
}

function isCheckoutAddress(value: unknown): value is CheckoutAddress {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CheckoutAddress>;
  return Boolean(candidate.email && candidate.first_name && candidate.last_name && candidate.address_1 && candidate.city && candidate.postal_code && candidate.country_code && candidate.phone);
}

function readStoredReviews() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(reviewStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isProductReview) : [];
  } catch {
    return [];
  }
}

function writeStoredReviews(reviews: ProductReview[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(reviewStorageKey, JSON.stringify(reviews));
}

function isProductReview(value: unknown): value is ProductReview {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ProductReview>;
  return Boolean(candidate.id && candidate.product_id && candidate.author && candidate.title && candidate.body && candidate.created_at && typeof candidate.rating === "number");
}

function readStoredQuestions() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(questionStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isProductQuestion) : [];
  } catch {
    return [];
  }
}

function writeStoredQuestions(questions: ProductQuestion[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(questionStorageKey, JSON.stringify(questions));
}

function isProductQuestion(value: unknown): value is ProductQuestion {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ProductQuestion>;
  return Boolean(candidate.id && candidate.product_id && candidate.author && candidate.question && candidate.created_at);
}

export function useStorefront() {
  const context = useContext(StorefrontContext);

  if (!context) {
    throw new Error("useStorefront must be used inside StorefrontProvider");
  }

  return context;
}
