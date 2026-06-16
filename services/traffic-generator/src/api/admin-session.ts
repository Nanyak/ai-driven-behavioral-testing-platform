import type { ApiResponse, MedusaClient } from "../client.js";
import { pick } from "../util/random.js";
import { MISSING, recordStep, type StepResult } from "./step.js";

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
