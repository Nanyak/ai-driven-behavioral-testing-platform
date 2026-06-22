import type { ApiResponse, MedusaClient } from "../http/client.js";
import { randomUUID } from "node:crypto";
import { pick } from "../util/random.js";
import { MISSING, recordStep, type StepResult } from "../http/step.js";

/** For the stock-out arc (Theme 3). */
export interface CreatedProduct {
  productId: string;
  variantId: string;
  inventoryItemId?: string;
  locationId?: string;
}

/**
 * Establishes the admin role naturally via POST /auth/user/emailpass — the
 * logging middleware records actor_type "user" from the resulting JWT.
 */
export class AdminSession {
  token?: string;
  productIds: string[] = [];
  stockLocationId?: string;
  salesChannelId?: string;
  shippingProfileId?: string;
  steps: StepResult[] = [];

  constructor(
    public readonly client: MedusaClient,
    private readonly email: string,
    private readonly password: string
  ) {}

  private record(action: string, method: string, path: string, res: ApiResponse): ApiResponse {
    return recordStep(this.steps, action, method, path, res);
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
      return this.record("admin_view_product", "GET", "/admin/products/{id}", MISSING);
    }
    const res = await this.client.request("GET", `/admin/products/${id}`, { token: this.token });
    return this.record("admin_view_product", "GET", "/admin/products/{id}", res);
  }

  async updateProduct(): Promise<ApiResponse> {
    const id = pick(this.productIds);
    if (!id) {
      return this.record("admin_update_product", "POST", "/admin/products/{id}", MISSING);
    }
    const res = await this.client.request("POST", `/admin/products/${id}`, {
      token: this.token,
      body: { metadata: { reviewed_at: new Date().toISOString() } },
    });
    return this.record("admin_update_product", "POST", "/admin/products/{id}", res);
  }

  /**
   * Resolve (and cache) the sales channel a new product must be linked to so it
   * is visible/purchasable in the Store API. A product created without a sales
   * channel is invisible in /store, so the stock-out arc could never add it to a
   * cart. VERIFY against live backend: confirmed the seed's single
   * "Default Sales Channel" is the one store carts resolve against.
   */
  private async resolveSalesChannel(): Promise<string | undefined> {
    if (this.salesChannelId) return this.salesChannelId;
    const res = await this.client.request("GET", "/admin/sales-channels?limit=1", {
      token: this.token,
    });
    this.record("admin_list_sales_channels", "GET", "/admin/sales-channels", res);
    this.salesChannelId = res.ok ? res.body?.sales_channels?.[0]?.id : undefined;
    return this.salesChannelId;
  }

  /**
   * Create a published product with a single "One Size" variant (plan §8.5; the
   * seller's core catalog loop + the prerequisite for the customer stock-out
   * arc, Theme 3). Resolves the shipping profile, sales channel, and — for the
   * stock-out product — the created variant's inventory item + stock location so
   * the orchestrator can pin its stock with setInventoryLevel().
   *
   * VERIFY against live backend (Medusa 2.15.5): the create body needs
   * `sales_channels` for store visibility (the minimal Theme-3 body omitted it
   * and the product was unpurchasable); a fresh variant's inventory item is NOT
   * yet stocked at any location, so it is resolved here and stocked separately.
   * Degrades to a logged non-2xx (returns `created: undefined`) rather than
   * crashing if any version-sensitive step 4xxs.
   */
  async createProduct(
    opts: { lowStock?: boolean } = {}
  ): Promise<{ res: ApiResponse; created?: CreatedProduct }> {
    if (!this.shippingProfileId) {
      const profiles = await this.client.request("GET", "/admin/shipping-profiles?limit=1", {
        token: this.token,
      });
      this.record("admin_list_shipping_profiles", "GET", "/admin/shipping-profiles", profiles);
      this.shippingProfileId = profiles.ok ? profiles.body?.shipping_profiles?.[0]?.id : undefined;
    }
    const salesChannelId = await this.resolveSalesChannel();

    const suffix = randomUUID().slice(0, 8);
    const sku = `GEN-${opts.lowStock ? "LOWSTOCK" : "CATALOG"}-${suffix}`;
    const body: Record<string, unknown> = {
      title: `Generated Product ${suffix}`,
      status: "published",
      shipping_profile_id: this.shippingProfileId,
      options: [{ title: "Size", values: ["One Size"] }],
      variants: [
        {
          title: "Default",
          sku,
          options: { Size: "One Size" },
          prices: [{ amount: 1500, currency_code: "eur" }],
        },
      ],
    };
    // Link to the sales channel so the variant is purchasable in /store.
    if (salesChannelId) body.sales_channels = [{ id: salesChannelId }];

    const res = await this.client.request("POST", "/admin/products", {
      token: this.token,
      body,
    });
    this.record("admin_create_product", "POST", "/admin/products", res);
    if (!res.ok) {
      return { res };
    }

    const product = res.body?.product;
    const variantId: string | undefined = product?.variants?.[0]?.id;
    if (product?.id) this.productIds.push(product.id);
    if (!variantId) {
      return { res };
    }

    const created: CreatedProduct = { productId: product.id, variantId };
    // The stock-out product needs its inventory item + location resolved so the
    // orchestrator can pin a low stocked_quantity. The create response carries no
    // inventory item, so look it up by the just-generated (unique) SKU.
    if (opts.lowStock) {
      const items = await this.client.request(
        "GET",
        `/admin/inventory-items?sku=${encodeURIComponent(sku)}&limit=1`,
        { token: this.token }
      );
      this.record("admin_list_inventory_items", "GET", "/admin/inventory-items", items);
      created.inventoryItemId = items.ok ? items.body?.inventory_items?.[0]?.id : undefined;
      created.locationId = await this.resolveStockLocation();
    }
    return { res, created };
  }

  /**
   * Stock an inventory item at a location (Theme 3). Uses the create endpoint
   * `POST /admin/inventory-items/{id}/location-levels` with `location_id` in the
   * body: a freshly-created variant's inventory item is not yet stocked at any
   * location, so the per-location update endpoint 404s ("not stocked at
   * location") until this association exists. This single call both associates
   * and sets the quantity. VERIFY against live backend (Medusa 2.15.5).
   */
  async setInventoryLevel(
    inventoryItemId: string,
    locationId: string,
    qty: number
  ): Promise<ApiResponse> {
    const res = await this.client.request(
      "POST",
      `/admin/inventory-items/${inventoryItemId}/location-levels`,
      { token: this.token, body: { location_id: locationId, stocked_quantity: qty } }
    );
    return this.record(
      "admin_set_inventory_level",
      "POST",
      "/admin/inventory-items/{id}/location-levels",
      res
    );
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
   * succeed (plan §5 Stage 0). The order-level `application_method`
   * (`target_type:"order"`, `allocation:"across"`) body is **verified working
   * (200)** on this Medusa 2.15.5 build — the old "POST /admin/promotions 400"
   * project note was stale (the discount applies on a checkout cart). The
   * `application_method` shape is still version-sensitive across 2.x minors, so
   * it stays marked `// VERIFY against live backend` and degrades to a logged
   * non-2xx rather than crashing.
   */
  async createPromotion(code: string, currencyCode = "eur"): Promise<ApiResponse> {
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
   * Resolve (and cache) a stock location for receiving returns. The return
   * receive workflow's inventory step fails ("Cannot receive the Return at
   * location null") unless the return is bound to a location at begin time.
   */
  async resolveStockLocation(): Promise<string | undefined> {
    if (this.stockLocationId) return this.stockLocationId;
    const res = await this.client.request("GET", "/admin/stock-locations?limit=1", {
      token: this.token,
    });
    this.record("admin_list_stock_locations", "GET", "/admin/stock-locations", res);
    this.stockLocationId = res.ok ? res.body?.stock_locations?.[0]?.id : undefined;
    return this.stockLocationId;
  }

  /**
   * Begin a draft return for an order (plan §5 Stage 2 F3) and resolve its id.
   * `location_id` is required for the later receive/confirm to settle. VERIFY:
   * the begin-return response carries the new return under `return` on this
   * build; the `order_id` filter is the fallback if a future minor changes that.
   */
  async beginReturn(
    orderId: string,
    locationId?: string
  ): Promise<{ returnId?: string; res: ApiResponse }> {
    const body: Record<string, unknown> = { order_id: orderId };
    if (locationId) body.location_id = locationId;
    const res = await this.client.request("POST", "/admin/returns", { token: this.token, body });
    this.record("admin_begin_return", "POST", "/admin/returns", res);
    let returnId: string | undefined = res.ok ? res.body?.return?.id : undefined;
    if (res.ok && !returnId) {
      const list = await this.client.request(
        "GET",
        `/admin/returns?order_id=${encodeURIComponent(orderId)}&order=-created_at&limit=1`,
        { token: this.token }
      );
      returnId = list.ok ? list.body?.returns?.[0]?.id : undefined;
    }
    return { returnId, res };
  }

  async requestReturnItems(
    returnId: string,
    items: { id: string; quantity: number }[]
  ): Promise<ApiResponse> {
    const res = await this.client.request("POST", `/admin/returns/${returnId}/request-items`, {
      token: this.token,
      body: { items },
    });
    return this.record("admin_request_return_items", "POST", "/admin/returns/{id}/request-items", res);
  }

  async confirmReturnRequest(returnId: string): Promise<ApiResponse> {
    const res = await this.client.request("POST", `/admin/returns/${returnId}/request`, {
      token: this.token,
      body: {},
    });
    return this.record("admin_request_return", "POST", "/admin/returns/{id}/request", res);
  }

  async receiveReturn(returnId: string): Promise<ApiResponse> {
    const res = await this.client.request("POST", `/admin/returns/${returnId}/receive`, {
      token: this.token,
      body: {},
    });
    return this.record("admin_receive_return", "POST", "/admin/returns/{id}/receive", res);
  }

  async receiveReturnItems(
    returnId: string,
    items: { id: string; quantity: number }[]
  ): Promise<ApiResponse> {
    const res = await this.client.request("POST", `/admin/returns/${returnId}/receive-items`, {
      token: this.token,
      body: { items },
    });
    return this.record("admin_receive_return_items", "POST", "/admin/returns/{id}/receive-items", res);
  }

  async confirmReturnReceipt(returnId: string): Promise<ApiResponse> {
    const res = await this.client.request("POST", `/admin/returns/${returnId}/receive/confirm`, {
      token: this.token,
      body: {},
    });
    return this.record("admin_confirm_return_receipt", "POST", "/admin/returns/{id}/receive/confirm", res);
  }

  /**
   * Reject (cancel) a requested return instead of receiving/refunding it — the
   * third admin reversal archetype (ADR 0003), modelling an operator declining a
   * return after the customer filed it. Operates on a return in `requested`
   * state (begin -> request-items -> request).
   *
   * VERIFY against live backend (Medusa 2.15.5): the cancel endpoint takes an
   * **empty body**. The Theme-4 spec's `{ items: [{ id, quantity }] }` shape is
   * rejected on this build with 400 "Unrecognized fields: 'items'" — the cancel
   * is whole-return, not per-item — so no items are sent. Degrades to a logged
   * non-2xx rather than crashing.
   */
  async cancelReturn(returnId: string): Promise<ApiResponse> {
    const res = await this.client.request("POST", `/admin/returns/${returnId}/cancel`, {
      token: this.token,
      body: {},
    });
    return this.record("admin_cancel_return", "POST", "/admin/returns/{id}/cancel", res);
  }

  /**
   * Cancel an order (plan §5 Stage 2 F5) — the reversal path for an order that
   * has NOT shipped yet. The backend rejects canceling a fulfilled order ("All
   * fulfillments must be canceled first"), so callers pass unfulfilled orders.
   * Canceling reverses the authorized payment (refund-equivalent).
   */
  async cancelOrder(orderId: string): Promise<ApiResponse> {
    const res = await this.client.request("POST", `/admin/orders/${orderId}/cancel`, {
      token: this.token,
      body: {},
    });
    return this.record("admin_cancel_order", "POST", "/admin/orders/{id}/cancel", res);
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
