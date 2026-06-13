import type { ApiResponse, MedusaClient } from "./client.js";
import { newCustomerEmail } from "./ids.js";

export interface StepResult {
  action: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
}

interface ProductLite {
  id: string;
  variantId?: string;
}

function pick<T>(items: T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  return items[Math.floor(Math.random() * items.length)];
}

export const DEFAULT_PASSWORD = "Password123!";

const PRODUCT_FIELDS =
  "*variants.calculated_price,+variants.inventory_quantity,*variants.options,*options";

/**
 * Drives the Medusa Store API for one shopping session. Every method records a
 * StepResult and is self-healing (lazily resolves region/products/cart) so it
 * works whether called as a scripted backbone or in an arbitrary LLM-chosen
 * order. IDs are always resolved at runtime — never hardcoded (plan §risks).
 */
export class StoreSession {
  regionId?: string;
  products: ProductLite[] = [];
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
    this.steps.push({ action, method, path, status: res.status, ok: res.ok });
    return res;
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
      this.regionId = res.body?.regions?.[0]?.id;
    }
    return this.record("load_regions", "GET", "/store/regions", res);
  }

  async browseProducts(): Promise<ApiResponse> {
    await this.ensureRegion();
    const params = new URLSearchParams({ limit: "20", fields: PRODUCT_FIELDS });
    if (this.regionId) {
      params.set("region_id", this.regionId);
    }
    const path = `/store/products?${params.toString()}`;
    const res = await this.client.request("GET", path);
    if (res.ok && Array.isArray(res.body?.products)) {
      this.products = res.body.products.map((p: any) => ({
        id: p.id,
        variantId: p?.variants?.[0]?.id,
      }));
    }
    return this.record("browse_products", "GET", "/store/products", res);
  }

  async viewProduct(): Promise<ApiResponse> {
    await this.ensureProducts();
    const product = pick(this.products);
    if (!product) {
      return this.record("view_product", "GET", "/store/products/{id}", {
        status: 0,
        ok: false,
        body: null,
      });
    }
    const params = new URLSearchParams({ fields: PRODUCT_FIELDS });
    if (this.regionId) {
      params.set("region_id", this.regionId);
    }
    const path = `/store/products/${product.id}?${params.toString()}`;
    const res = await this.client.request("GET", path);
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
      // No prior registration in this session — register first.
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

  async addItem(): Promise<ApiResponse> {
    await this.ensureCart();
    await this.ensureProducts();
    const variant = pick(this.products.filter((p) => p.variantId))?.variantId;
    if (!this.cartId || !variant) {
      return this.record("add_item", "POST", "/store/carts/{id}/line-items", {
        status: 0,
        ok: false,
        body: null,
      });
    }
    const res = await this.client.request("POST", `/store/carts/${this.cartId}/line-items`, {
      body: { variant_id: variant, quantity: 1 },
      token: this.token,
    });
    if (res.ok && Array.isArray(res.body?.cart?.items)) {
      this.items = res.body.cart.items.map((i: any) => ({ id: i.id, variantId: i.variant_id }));
    }
    return this.record("add_item", "POST", "/store/carts/{id}/line-items", res);
  }

  async updateItem(): Promise<ApiResponse> {
    const item = pick(this.items);
    if (!this.cartId || !item) {
      return this.record("update_item", "POST", "/store/carts/{id}/line-items/{lineId}", {
        status: 0,
        ok: false,
        body: null,
      });
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
      return this.record("remove_item", "DELETE", "/store/carts/{id}/line-items/{lineId}", {
        status: 0,
        ok: false,
        body: null,
      });
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

  async applyPromo(): Promise<ApiResponse> {
    await this.ensureCart();
    // The promo code is intentionally unlikely to exist — exercises a realistic
    // "tried a code that didn't apply" path (may 200 with no discount or 400).
    const res = await this.client.request("POST", `/store/carts/${this.cartId}`, {
      body: { promo_codes: ["WELCOME10"] },
      token: this.token,
    });
    return this.record("apply_promo", "POST", "/store/carts/{id}", res);
  }

  async setAddress(): Promise<ApiResponse> {
    await this.ensureCart();
    const address = {
      first_name: "Behavior",
      last_name: "Shopper",
      address_1: "1 Market Street",
      city: "San Francisco",
      postal_code: "94105",
      country_code: "us",
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
      return this.record("add_shipping", "POST", "/store/carts/{id}/shipping-methods", {
        status: 0,
        ok: false,
        body: null,
      });
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
        { status: 0, ok: false, body: null }
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

  /** Runs the full checkout prerequisite chain (address -> shipping -> payment). */
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
      return this.record("view_order", "GET", "/store/orders/{id}", {
        status: 0,
        ok: false,
        body: null,
      });
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
    const params = new URLSearchParams({ limit: "20", fields: PRODUCT_FIELDS });
    if (this.regionId) params.set("region_id", this.regionId);
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok && Array.isArray(res.body?.products)) {
      this.products = res.body.products.map((p: any) => ({
        id: p.id,
        variantId: p?.variants?.[0]?.id,
      }));
    }
  }

  async viewCart(): Promise<ApiResponse> {
    if (!this.cartId) {
      return this.record("view_cart", "GET", "/store/carts/{id}", { status: 0, ok: false, body: null });
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
    const params = new URLSearchParams({ limit: "20", q: query, fields: PRODUCT_FIELDS });
    if (this.regionId) {
      params.set("region_id", this.regionId);
    }
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    if (res.ok && Array.isArray(res.body?.products)) {
      this.products = res.body.products.map((p: any) => ({
        id: p.id,
        variantId: p?.variants?.[0]?.id,
      }));
    }
    return this.record("search_products", "GET", "/store/products", res);
  }

  async filterProducts(): Promise<ApiResponse> {
    const cats = await this.client.request("GET", "/store/product-categories?limit=10");
    this.record("list_categories", "GET", "/store/product-categories", cats);
    const categoryId = cats.ok ? cats.body?.product_categories?.[0]?.id : undefined;
    await this.ensureRegion();
    const params = new URLSearchParams({ limit: "20", fields: PRODUCT_FIELDS });
    if (this.regionId) {
      params.set("region_id", this.regionId);
    }
    if (categoryId) {
      params.set("category_id[]", categoryId);
    }
    const res = await this.client.request("GET", `/store/products?${params.toString()}`);
    return this.record("filter_products", "GET", "/store/products", res);
  }

  async updateProfile(): Promise<ApiResponse> {
    const res = await this.client.request("POST", "/store/customers/me", {
      token: this.token,
      body: { first_name: "Behavior", last_name: "Shopper", company_name: "Test Co" },
    });
    return this.record("update_profile", "POST", "/store/customers/me", res);
  }

  async addAddress(): Promise<ApiResponse> {
    const res = await this.client.request("POST", "/store/customers/me/addresses", {
      token: this.token,
      body: {
        address_name: "Home",
        first_name: "Behavior",
        last_name: "Shopper",
        address_1: "1 Market Street",
        city: "San Francisco",
        postal_code: "94105",
        country_code: "us",
        phone: "5551234567",
      },
    });
    return this.record("add_address", "POST", "/store/customers/me/addresses", res);
  }

  /** Apply a specific promo code (valid or invalid) — both emit the same event. */
  async applyPromoCode(code: string): Promise<ApiResponse> {
    await this.ensureCart();
    const res = await this.client.request("POST", `/store/carts/${this.cartId}`, {
      body: { promo_codes: [code] },
      token: this.token,
    });
    return this.record("apply_promo", "POST", "/store/carts/{id}", res);
  }

  // --- Stage-2 additions (plan §6.5) — VERIFY endpoint shapes against live 2.15.5 ---

  async getReturnReasons(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/store/return-reasons", { token: this.token });
    return this.record("get_return_reasons", "GET", "/store/return-reasons", res);
  }

  /**
   * Request a return against a REAL completed order (plan §5 Stage 2 / §risks).
   * Resolves the order's line-item ids and a return reason at runtime — never
   * fabricated. VERIFY: `POST /store/returns` body shape
   * (createAndCompleteReturnOrderWorkflow) varies across Medusa 2.x minors; this
   * degrades to a logged 4xx if the shape is off rather than crashing.
   */
  async requestReturn(orderId: string): Promise<{ returnId?: string; res: ApiResponse }> {
    const order = await this.client.request("GET", `/store/orders/${orderId}`, {
      token: this.token,
    });
    this.record("view_order", "GET", "/store/orders/{id}", order);
    const items: any[] = order.ok ? order.body?.order?.items ?? [] : [];
    if (items.length === 0) {
      const miss = this.record("request_return", "POST", "/store/returns", {
        status: 0,
        ok: false,
        body: null,
      });
      return { res: miss };
    }
    const reasons = await this.getReturnReasons();
    const reasonId = reasons.ok ? reasons.body?.return_reasons?.[0]?.id : undefined;
    const item = items[Math.floor(Math.random() * items.length)];
    const res = await this.client.request("POST", "/store/returns", {
      token: this.token,
      body: {
        order_id: orderId,
        items: [{ id: item.id, quantity: 1, ...(reasonId ? { reason_id: reasonId } : {}) }],
      },
    });
    this.record("request_return", "POST", "/store/returns", res);
    const returnId = res.ok ? res.body?.return?.id : undefined;
    return { returnId, res };
  }

  /** Reorder a previously purchased variant into a fresh cart (status-check reorder). */
  async reorder(variantId: string): Promise<ApiResponse> {
    await this.createCart();
    if (!this.cartId) {
      return this.record("reorder", "POST", "/store/carts/{id}/line-items", {
        status: 0,
        ok: false,
        body: null,
      });
    }
    const res = await this.client.request("POST", `/store/carts/${this.cartId}/line-items`, {
      body: { variant_id: variantId, quantity: 1 },
      token: this.token,
    });
    return this.record("reorder", "POST", "/store/carts/{id}/line-items", res);
  }
}

/**
 * Drives the Medusa Admin API for one operator session. Establishes the admin
 * role naturally via POST /auth/user/emailpass — the logging middleware records
 * actor_type "user" from the resulting JWT.
 */
export class AdminSession {
  token?: string;
  productIds: string[] = [];
  steps: StepResult[] = [];

  constructor(
    public readonly client: MedusaClient,
    private readonly email: string,
    private readonly password: string
  ) {}

  private record(action: string, method: string, path: string, res: ApiResponse): ApiResponse {
    this.steps.push({ action, method, path, status: res.status, ok: res.ok });
    return res;
  }

  async login(): Promise<ApiResponse> {
    const res = await this.client.request("POST", "/auth/user/emailpass", {
      body: { email: this.email, password: this.password },
    });
    if (res.ok && res.body?.token) {
      this.token = res.body.token;
    }
    return this.record("admin_login", "POST", "/auth/user/emailpass", res);
  }

  async listProducts(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/admin/products?limit=20", {
      token: this.token,
    });
    if (res.ok && Array.isArray(res.body?.products)) {
      this.productIds = res.body.products.map((p: any) => p.id);
    }
    return this.record("admin_list_products", "GET", "/admin/products", res);
  }

  async viewProduct(): Promise<ApiResponse> {
    const id = pick(this.productIds);
    if (!id) {
      return this.record("admin_view_product", "GET", "/admin/products/{id}", {
        status: 0,
        ok: false,
        body: null,
      });
    }
    const res = await this.client.request("GET", `/admin/products/${id}`, { token: this.token });
    return this.record("admin_view_product", "GET", "/admin/products/{id}", res);
  }

  async updateProduct(): Promise<ApiResponse> {
    const id = pick(this.productIds);
    if (!id) {
      return this.record("admin_update_product", "POST", "/admin/products/{id}", {
        status: 0,
        ok: false,
        body: null,
      });
    }
    // Touch a metadata note — a benign admin edit that succeeds on any product.
    const res = await this.client.request("POST", `/admin/products/${id}`, {
      token: this.token,
      body: { metadata: { reviewed_at: new Date().toISOString() } },
    });
    return this.record("admin_update_product", "POST", "/admin/products/{id}", res);
  }

  async listOrders(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/admin/orders?limit=20", { token: this.token });
    return this.record("admin_list_orders", "GET", "/admin/orders", res);
  }

  async listCustomers(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/admin/customers?limit=20", {
      token: this.token,
    });
    return this.record("admin_list_customers", "GET", "/admin/customers", res);
  }

  // --- Stage-0 / Stage-2 additions (plan §6.5) — VERIFY shapes against live 2.15.5 ---

  /**
   * Seed a valid percentage promotion so deal-seeker conversions can actually
   * succeed (plan §5 Stage 0). VERIFY: the Medusa 2.x promotions create body
   * (`application_method`) is version-sensitive.
   */
  async createPromotion(code: string, currencyCode = "usd"): Promise<ApiResponse> {
    const res = await this.client.request("POST", "/admin/promotions", {
      token: this.token,
      body: {
        code,
        type: "standard",
        status: "active",
        application_method: {
          type: "percentage",
          value: 10,
          target_type: "order",
          allocation: "across",
          currency_code: currencyCode,
        },
      },
    });
    return this.record("admin_create_promotion", "POST", "/admin/promotions", res);
  }

  async getOrder(orderId: string): Promise<ApiResponse> {
    const res = await this.client.request("GET", `/admin/orders/${orderId}`, {
      token: this.token,
    });
    return this.record("admin_view_order", "GET", "/admin/orders/{id}", res);
  }

  async listReturns(): Promise<ApiResponse> {
    const res = await this.client.request("GET", "/admin/returns?limit=20", {
      token: this.token,
    });
    return this.record("admin_list_returns", "GET", "/admin/returns", res);
  }

  /**
   * Fulfill a real completed order (plan §5 Stage 2 F2). VERIFY:
   * `POST /admin/orders/{id}/fulfillments` item shape varies across 2.x.
   */
  async createFulfillment(orderId: string): Promise<ApiResponse> {
    const order = await this.getOrder(orderId);
    const items: any[] = order.ok ? order.body?.order?.items ?? [] : [];
    const res = await this.client.request("POST", `/admin/orders/${orderId}/fulfillments`, {
      token: this.token,
      body: { items: items.slice(0, 1).map((i: any) => ({ id: i.id, quantity: 1 })) },
    });
    return this.record("admin_create_fulfillment", "POST", "/admin/orders/{id}/fulfillments", res);
  }

  /**
   * Process a refund against the SAME order_id the customer filed a return on
   * (plan §5 Stage 2 F3) — the cross-role linkage Phase 7 joins on. VERIFY: the
   * admin return-receive + refund sequence is the most version-sensitive path in
   * 2.x; each call degrades to a logged 4xx if the shape is off.
   */
  async processRefund(orderId: string, returnId?: string): Promise<ApiResponse> {
    // Touch the order so an admin event references this order_id even if the
    // refund call shape is wrong (keeps the linkage joinable on order_id).
    await this.getOrder(orderId);
    if (returnId) {
      const recv = await this.client.request("POST", `/admin/returns/${returnId}/receive`, {
        token: this.token,
        body: { items: [] },
      });
      this.record("admin_receive_return", "POST", "/admin/returns/{id}/receive", recv);
    }
    const res = await this.client.request("POST", `/admin/orders/${orderId}/refunds`, {
      token: this.token,
      body: { amount: 1, reason: "return" },
    });
    return this.record("admin_refund", "POST", "/admin/orders/{id}/refunds", res);
  }

  async searchCustomer(query: string): Promise<ApiResponse> {
    const res = await this.client.request(
      "GET",
      `/admin/customers?q=${encodeURIComponent(query)}&limit=10`,
      { token: this.token }
    );
    return this.record("admin_search_customer", "GET", "/admin/customers", res);
  }
}
