import type { ApiResponse, MedusaClient } from "../http/client.js";
import { newCustomerEmail } from "../config/ids.js";
import { pick } from "../util/random.js";
import { MISSING, recordStep, type StepResult } from "../http/step.js";
import {
  mapProducts,
  productListParams,
  type ProductLite,
  type SortOrder,
} from "./catalog-query.js";

export type { SortOrder };

export const DEFAULT_PASSWORD = "Password123!";

/**
 * Every method records a StepResult and is self-healing (lazily resolves
 * region/products/cart) so it works whether called as a scripted backbone or
 * in an arbitrary LLM-chosen order. IDs are always resolved at runtime — never
 * hardcoded (plan §risks).
 */
export class StoreSession {
  regionId?: string;
  /** First ISO-2 country of the cart's region — address country must be in-region. */
  countryCode?: string;
  products: ProductLite[] = [];
  categories: string[] = [];
  cartId?: string;
  items: { id: string; variantId: string }[] = [];
  token?: string;
  email?: string;
  paymentCollectionId?: string;
  providerId?: string;
  lastOrderId?: string;
  steps: StepResult[] = [];

  constructor(public readonly client: MedusaClient) {}

  private record(action: string, method: string, path: string, res: ApiResponse): ApiResponse {
    return recordStep(this.steps, action, method, path, res);
  }

  async ensureRegion(): Promise<void> {
    if (!this.regionId) {
      await this.loadRegions();
    }
  }

  async ensureProducts(): Promise<void> {
    if (this.products.length === 0) {
      await this.browseProducts();
    }
  }

  async ensureCart(): Promise<void> {
    if (!this.cartId) {
      await this.createCart();
    }
  }

  async loadRegions(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/store/regions");
    if (res.ok) {
      const region = res.body?.regions?.[0];
      this.regionId = region?.id;
      // The cart address country must be within the cart's region, or
      // POST /store/carts/{id} 400s ("Country ... is not within region").
      // Resolve it from the live region — the seed ships a single non-US
      // (European) region, so a hardcoded "us" always failed.
      this.countryCode = region?.countries?.[0]?.iso_2 ?? this.countryCode;
    }
    return this.record("load_regions", "GET", "/store/regions", res);
  }

  async browseProducts(): Promise<ApiResponse> {
    await this.ensureRegion();
    const params = productListParams(this.regionId, { limit: "20" });
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok) {
      this.products = mapProducts(res);
    }
    return this.record("browse_products", "GET", "/store/products", res);
  }

  async viewProduct(): Promise<ApiResponse> {
    await this.ensureProducts();
    const product = pick(this.products);
    if (!product) {
      return this.record("view_product", "GET", "/store/products/{id}", MISSING);
    }
    const params = productListParams(this.regionId);
    const res = await this.client.request("GET", `/store/products/${product.id}?${params.toString()}`);
    return this.record("view_product", "GET", "/store/products/{id}", res);
  }

  /** The stock-out arc lands on the dedicated low-stock product, which isn't
   * in the random browse list. */
  async viewProductById(productId: string): Promise<ApiResponse> {
    await this.ensureRegion();
    const params = productListParams(this.regionId);
    const res = await this.client.request("GET", `/store/products/${productId}?${params.toString()}`);
    return this.record("view_product", "GET", "/store/products/{id}", res);
  }

  async register(): Promise<ApiResponse> {
    this.email = newCustomerEmail();
    const authRes = await this.client.request("POST", "/auth/customer/emailpass/register", {
      body: { email: this.email, password: DEFAULT_PASSWORD },
    });
    this.record("register", "POST", "/auth/customer/emailpass/register", authRes);
    if (!authRes.ok || !authRes.body?.token) {
      return authRes;
    }
    this.token = authRes.body.token;
    const customerRes = await this.client.request("POST", "/store/customers", {
      token: this.token,
      body: { email: this.email, first_name: "Behavior", last_name: "Shopper" },
    });
    return this.record("create_customer", "POST", "/store/customers", customerRes);
  }

  async login(): Promise<ApiResponse> {
    if (!this.email) {
      await this.register();
    }
    const res = await this.client.request("POST", "/auth/customer/emailpass", {
      body: { email: this.email, password: DEFAULT_PASSWORD },
    });
    if (res.ok && res.body?.token) {
      this.token = res.body.token;
    }
    return this.record("login", "POST", "/auth/customer/emailpass", res);
  }

  async viewProfile(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/store/customers/me", { token: this.token });
    return this.record("view_profile", "GET", "/store/customers/me", res);
  }

  async createCart(): Promise<ApiResponse> {
    await this.ensureRegion();
    const res = await this.client.request("POST", "/store/carts", {
      body: this.regionId ? { region_id: this.regionId } : {},
      token: this.token,
    });
    if (res.ok && res.body?.cart?.id) {
      this.cartId = res.body.cart.id;
    }
    return this.record("create_cart", "POST", "/store/carts", res);
  }

  /**
   * With no args it picks a random in-stock variant; `variantId`/`quantity`
   * target a specific variant and amount — used by the stock-out arc to add
   * `stock + 1` of the low-stock variant (expecting a 400) and then a
   * recovering quantity of 1.
   */
  async addItem(variantId?: string, quantity = 1): Promise<ApiResponse> {
    await this.ensureCart();
    let variant = variantId;
    if (!variant) {
      await this.ensureProducts();
      variant = pick(this.products.filter((p) => p.variantId))?.variantId;
    }
    if (!this.cartId || !variant) {
      return this.record("add_item", "POST", "/store/carts/{id}/line-items", MISSING);
    }
    const res = await this.client.request("POST", `/store/carts/${this.cartId}/line-items`, {
      body: { variant_id: variant, quantity },
      token: this.token,
    });
    if (res.ok && Array.isArray(res.body?.cart?.items)) {
      // `any`: Medusa cart line item — only the line id and variant_id are read.
      this.items = res.body.cart.items.map((i: any) => ({ id: i.id, variantId: i.variant_id }));
    }
    return this.record("add_item", "POST", "/store/carts/{id}/line-items", res);
  }

  async updateItem(): Promise<ApiResponse> {
    const item = pick(this.items);
    if (!this.cartId || !item) {
      return this.record("update_item", "POST", "/store/carts/{id}/line-items/{lineId}", MISSING);
    }
    const res = await this.client.request(
      "POST",
      `/store/carts/${this.cartId}/line-items/${item.id}`,
      { body: { quantity: 1 + Math.floor(Math.random() * 2) }, token: this.token }
    );
    return this.record("update_item", "POST", "/store/carts/{id}/line-items/{lineId}", res);
  }

  async removeItem(): Promise<ApiResponse> {
    const item = pick(this.items);
    if (!this.cartId || !item) {
      return this.record("remove_item", "DELETE", "/store/carts/{id}/line-items/{lineId}", MISSING);
    }
    const res = await this.client.request(
      "DELETE",
      `/store/carts/${this.cartId}/line-items/${item.id}`,
      { token: this.token }
    );
    if (res.ok) {
      this.items = this.items.filter((i) => i.id !== item.id);
    }
    return this.record("remove_item", "DELETE", "/store/carts/{id}/line-items/{lineId}", res);
  }

  async setAddress(): Promise<ApiResponse> {
    await this.ensureCart();
    const address = {
      first_name: "Behavior",
      last_name: "Shopper",
      address_1: "1 Main Street",
      city: "Capital",
      postal_code: "10000",
      country_code: this.countryCode ?? "de", // in-region (seed region is European)
      phone: "5551234567",
    };
    const res = await this.client.request("POST", `/store/carts/${this.cartId}`, {
      body: {
        email: this.email ?? newCustomerEmail(),
        shipping_address: address,
        billing_address: address,
      },
      token: this.token,
    });
    if (res.ok && !this.email) {
      this.email = res.body?.cart?.email;
    }
    return this.record("set_address", "POST", "/store/carts/{id}", res);
  }

  async listShipping(): Promise<ApiResponse> {
    await this.ensureCart();
    const path = `/store/shipping-options?cart_id=${encodeURIComponent(this.cartId ?? "")}`;
    const res = await this.client.request("GET", path, { token: this.token });
    return this.record("list_shipping", "GET", "/store/shipping-options", res);
  }

  async addShipping(): Promise<ApiResponse> {
    const options = await this.listShipping();
    const optionId = options.ok ? options.body?.shipping_options?.[0]?.id : undefined;
    if (!this.cartId || !optionId) {
      return this.record("add_shipping", "POST", "/store/carts/{id}/shipping-methods", MISSING);
    }
    const res = await this.client.request(
      "POST",
      `/store/carts/${this.cartId}/shipping-methods`,
      { body: { option_id: optionId }, token: this.token }
    );
    return this.record("add_shipping", "POST", "/store/carts/{id}/shipping-methods", res);
  }

  async createPaymentCollection(): Promise<ApiResponse> {
    await this.ensureCart();
    const res = await this.client.request("POST", "/store/payment-collections", {
      body: { cart_id: this.cartId },
      token: this.token,
    });
    if (res.ok && res.body?.payment_collection?.id) {
      this.paymentCollectionId = res.body.payment_collection.id;
    }
    return this.record("create_payment_collection", "POST", "/store/payment-collections", res);
  }

  async createPaymentSession(): Promise<ApiResponse> {
    if (!this.paymentCollectionId) {
      await this.createPaymentCollection();
    }
    if (!this.providerId && this.regionId) {
      const providers = await this.client.request(
        "GET",
        `/store/payment-providers?region_id=${encodeURIComponent(this.regionId)}`,
        { token: this.token }
      );
      this.record("list_payment_providers", "GET", "/store/payment-providers", providers);
      this.providerId = providers.ok
        ? providers.body?.payment_providers?.[0]?.id
        : undefined;
    }
    const providerId = this.providerId ?? "pp_system_default";
    if (!this.paymentCollectionId) {
      return this.record(
        "create_payment_session",
        "POST",
        "/store/payment-collections/{id}/payment-sessions",
        MISSING
      );
    }
    const res = await this.client.request(
      "POST",
      `/store/payment-collections/${this.paymentCollectionId}/payment-sessions`,
      { body: { provider_id: providerId, data: {} }, token: this.token }
    );
    return this.record(
      "create_payment_session",
      "POST",
      "/store/payment-collections/{id}/payment-sessions",
      res
    );
  }

  async ensureCheckoutReady(): Promise<void> {
    await this.setAddress();
    await this.addShipping();
    await this.createPaymentCollection();
    await this.createPaymentSession();
  }

  async complete(): Promise<ApiResponse> {
    await this.ensureCart();
    const res = await this.client.request("POST", `/store/carts/${this.cartId}/complete`, {
      token: this.token,
    });
    if (res.ok && res.body?.order?.id) {
      this.lastOrderId = res.body.order.id;
    }
    return this.record("complete_checkout", "POST", "/store/carts/{id}/complete", res);
  }

  async viewOrders(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/store/orders?limit=20&offset=0", {
      token: this.token,
    });
    return this.record("view_orders", "GET", "/store/orders", res);
  }

  async viewOrder(): Promise<ApiResponse> {
    if (!this.lastOrderId) {
      return this.record("view_order", "GET", "/store/orders/{id}", MISSING);
    }
    const res = await this.client.request("GET", `/store/orders/${this.lastOrderId}`, {
      token: this.token,
    });
    return this.record("view_order", "GET", "/store/orders/{id}", res);
  }

  // --- Stage-1 additions (plan §6.5) ---

  /**
   * Log into a PRE-EXISTING pooled account — the decoupler that finally makes
   * returning customers possible (plan §1.4). Unlike login(), it does NOT fall
   * back to register(), so a returning session emits `login` with no `register`,
   * which is exactly what lets Phase 7 separate signup from sign-in.
   */
  async loginExisting(email: string, password: string): Promise<ApiResponse> {
    this.email = email;
    const res = await this.client.request("POST", "/auth/customer/emailpass", {
      body: { email, password },
    });
    if (res.ok && res.body?.token) {
      this.token = res.body.token;
    }
    return this.record("login", "POST", "/auth/customer/emailpass", res);
  }

  /**
   * Resume a pre-authenticated session using a cached JWT — no auth endpoint is
   * hit. The session log starts with a browse/product call instead of a login
   * event, which is the distinguishing signal for JWT-reuse vs. fresh sign-in.
   */
  useExistingToken(email: string, token: string): void {
    this.email = email;
    this.token = token;
    this.steps.push({ action: "resume_session", method: "GET", path: "/auth/session", status: 200, ok: true });
  }

  /** Populate the product list without emitting a browse_products log step.
   * Used by direct-landing flows that start on a product detail page. */
  async prefetchProductIds(): Promise<void> {
    if (this.products.length > 0) return;
    await this.ensureRegion();
    const params = productListParams(this.regionId, { limit: "20" });
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok) {
      this.products = mapProducts(res);
    }
  }

  async viewCart(): Promise<ApiResponse> {
    if (!this.cartId) {
      return this.record("view_cart", "GET", "/store/carts/{id}", MISSING);
    }
    const res = await this.client.request("GET", `/store/carts/${this.cartId}`, { token: this.token });
    return this.record("view_cart", "GET", "/store/carts/{id}", res);
  }

  async viewMultipleProducts(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await this.viewProduct();
    }
  }

  async searchProducts(query: string): Promise<ApiResponse> {
    await this.ensureRegion();
    const params = productListParams(this.regionId, { limit: "20", q: query });
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok) {
      this.products = mapProducts(res);
    }
    return this.record("search_products", "GET", "/store/products", res);
  }

  async filterProducts(): Promise<ApiResponse> {
    const cats = await this.client.request("GET", "/store/product-categories?limit=10");
    this.record("list_categories", "GET", "/store/product-categories", cats);
    const categoryId = cats.ok ? cats.body?.product_categories?.[0]?.id : undefined;
    await this.ensureRegion();
    const params = productListParams(
      this.regionId,
      categoryId ? { limit: "20", "category_id[]": categoryId } : { limit: "20" }
    );
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    return this.record("filter_products", "GET", "/store/products", res);
  }

  // --- Catalog discovery (Theme 2): categories, pagination, sort ---

  async listCategories(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/store/product-categories?limit=10");
    if (res.ok && Array.isArray(res.body?.product_categories)) {
      // `any`: Medusa product-category — only the id is read.
      this.categories = res.body.product_categories.map((c: any) => c.id);
    }
    return this.record("list_categories", "GET", "/store/product-categories", res);
  }

  async browseByCategory(categoryId: string): Promise<ApiResponse> {
    await this.ensureRegion();
    const params = productListParams(this.regionId, { limit: "20", "category_id[]": categoryId });
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok) {
      this.products = mapProducts(res);
    }
    return this.record("browse_by_category", "GET", "/store/products", res);
  }

  async browsePage(offset: number, limit: number): Promise<ApiResponse> {
    await this.ensureRegion();
    const params = productListParams(this.regionId, {
      limit: String(limit),
      offset: String(offset),
    });
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok) {
      this.products = mapProducts(res);
    }
    return this.record("browse_page", "GET", "/store/products", res);
  }

  async sortProducts(order: SortOrder): Promise<ApiResponse> {
    await this.ensureRegion();
    const params = productListParams(this.regionId, { limit: "20", order });
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok) {
      this.products = mapProducts(res);
    }
    return this.record("sort_products", "GET", "/store/products", res);
  }

  /**
   * `POST /store/carts/{id} { promo_codes }` — the same cart-update endpoint used
   * for the address step, not a dedicated `/promotions` route (verified against
   * the live storefront, which has no promotions call). A valid order-level code
   * applies the discount (200); an unknown code surfaces a clean, countable 400
   * (`invalid_data` "The promotion code ... is invalid"). Both emit the same
   * `apply_promo` event so the success/failure split is a status signal, not a
   * separate endpoint (Theme 4a).
   */
  async applyPromoCode(code: string): Promise<ApiResponse> {
    await this.ensureCart();
    const res = await this.client.request("POST", `/store/carts/${this.cartId}`, {
      body: { promo_codes: [code] },
      token: this.token,
    });
    return this.record("apply_promo", "POST", "/store/carts/{id}", res);
  }

  // --- Stage-2 additions (plan §6.5) ---

  async reorder(variantId: string): Promise<ApiResponse> {
    await this.createCart();
    if (!this.cartId) {
      return this.record("reorder", "POST", "/store/carts/{id}/line-items", MISSING);
    }
    const res = await this.client.request("POST", `/store/carts/${this.cartId}/line-items`, {
      body: { variant_id: variantId, quantity: 1 },
      token: this.token,
    });
    return this.record("reorder", "POST", "/store/carts/{id}/line-items", res);
  }
}
