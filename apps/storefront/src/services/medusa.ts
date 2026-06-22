import type {
  Cart,
  CheckoutAddress,
  Customer,
  Order,
  OrderListResult,
  PaymentProvider,
  Product,
  Region,
  ShippingOption,
} from "../types/storefront";
import { getCustomerToken, setCustomerToken } from "./authToken";

const publishableApiKey = __MEDUSA_PUBLISHABLE_API_KEY__;

function medusaHeaders() {
  return {
    "Content-Type": "application/json",
    ...(publishableApiKey ? { "x-publishable-api-key": publishableApiKey } : {}),
    "x-session-id": "storefront-manual-session",
  };
}

async function medusaJson<T>(
  path: string,
  options: RequestInit & { auth?: boolean; authToken?: string } = {}
): Promise<T> {
  const { auth, authToken, ...fetchOptions } = options;
  const token = authToken || (auth ? getCustomerToken() : "");
  const response = await fetch(`/medusa${path}`, {
    ...fetchOptions,
    headers: {
      ...medusaHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(fetchOptions.headers ?? {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
  }

  return response.json() as Promise<T>;
}

export const medusaStore = {
  async listRegions() {
    const data = await medusaJson<{ regions: Region[] }>("/store/regions");
    return data.regions ?? [];
  },

  async listProducts() {
    const regions = await this.listRegions();
    const regionId = regions[0]?.id;
    const params = new URLSearchParams({
      limit: "24",
      fields: "*variants.calculated_price,+variants.inventory_quantity,+variants.manage_inventory,*collection,*tags,*images",
    });

    if (regionId) {
      params.set("region_id", regionId);
    }

    const data = await medusaJson<{ products: Product[] }>(`/store/products?${params.toString()}`);
    return data.products ?? [];
  },

  async registerCustomer(email: string, password: string) {
    const auth = await medusaJson<{ token: string }>("/auth/customer/emailpass/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    const created = await medusaJson<{ customer: Customer }>("/store/customers", {
      method: "POST",
      authToken: auth.token,
      body: JSON.stringify({
        email,
        first_name: "Behavior",
        last_name: "Shopper",
      }),
    });

    return { token: auth.token, customer: created.customer };
  },

  async loginCustomer(email: string, password: string) {
    const auth = await medusaJson<{ token: string }>("/auth/customer/emailpass", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    
    setCustomerToken(auth.token);
    
    const profile = await medusaJson<{ customer: Customer }>("/store/customers/me", {
      authToken: auth.token,
    });

    return { token: auth.token, customer: profile.customer };
  },

  async getCustomer() {
    const profile = await medusaJson<{ customer: Customer }>("/store/customers/me", {
      auth: true,
    });
    return profile.customer;
  },

  async createCart() {
    const regions = await this.listRegions();
    const regionId = regions[0]?.id;

    if (!regionId) {
      throw new Error("No Medusa region is available for cart creation.");
    }

    const created = await medusaJson<{ cart: Cart }>("/store/carts", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ region_id: regionId }),
    });

    return created.cart;
  },

  async getCart(cartId: string) {
    const latestCart = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}`);
    return latestCart.cart;
  },

  async getOrder(orderId: string) {
    const data = await medusaJson<{ order: Order }>(`/store/orders/${orderId}`);
    return data.order;
  },

  async listOrders() {
    const data = await medusaJson<OrderListResult>("/store/orders?limit=20&offset=0", {
      auth: true,
    });
    return data.orders ?? [];
  },

  async addLineItem(cartId: string, variantId: string, quantity = 1) {
    const updated = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}/line-items`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({
        variant_id: variantId,
        quantity,
      }),
    });

    return updated.cart;
  },

  async updateLineItem(cartId: string, lineItemId: string, quantity: number) {
    const updated = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}/line-items/${lineItemId}`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ quantity }),
    });

    return updated.cart;
  },

  async deleteLineItem(cartId: string, lineItemId: string) {
    const updated = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}/line-items/${lineItemId}`, {
      method: "DELETE",
      auth: true,
    });

    return updated.cart;
  },

  async getShippingOptions(cartId: string) {
    const options = await medusaJson<{ shipping_options: ShippingOption[] }>(
      `/store/shipping-options?cart_id=${encodeURIComponent(cartId)}`
    );
    return options.shipping_options ?? [];
  },

  async getPaymentProviders(regionId: string) {
    const providers = await medusaJson<{ payment_providers: PaymentProvider[] }>(
      `/store/payment-providers?region_id=${encodeURIComponent(regionId)}`
    );
    return providers.payment_providers ?? [];
  },

  async updateCheckoutAddress(cartId: string, address: CheckoutAddress) {
    const withAddress = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({
        email: address.email,
        shipping_address: {
          first_name: address.first_name,
          last_name: address.last_name,
          address_1: address.address_1,
          city: address.city,
          postal_code: address.postal_code,
          country_code: address.country_code,
          phone: address.phone,
        },
        billing_address: {
          first_name: address.first_name,
          last_name: address.last_name,
          address_1: address.address_1,
          city: address.city,
          postal_code: address.postal_code,
          country_code: address.country_code,
          phone: address.phone,
        },
      }),
    });

    return withAddress.cart;
  },

  async applyPromoCode(cartId: string, promoCode: string) {
    const withPromo = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({
        promo_codes: promoCode ? [promoCode] : [],
      }),
    });

    return withPromo.cart;
  },

  async addShippingMethod(cartId: string, optionId: string) {
    const withShipping = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}/shipping-methods`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ option_id: optionId }),
    });
    return withShipping.cart;
  },

  async createPaymentCollection(cartId: string) {
    const paymentCollection = await medusaJson<{ payment_collection: Cart["payment_collection"] }>(
      "/store/payment-collections",
      {
        method: "POST",
        auth: true,
        body: JSON.stringify({ cart_id: cartId }),
      }
    );

    return paymentCollection.payment_collection;
  },

  async createPaymentSession(collectionId: string, providerId: string) {
    const payment = await medusaJson<{ payment_collection: Cart["payment_collection"] }>(
      `/store/payment-collections/${collectionId}/payment-sessions`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify({ provider_id: providerId, data: {} }),
      }
    );

    return payment.payment_collection;
  },

  async completeCart(cartId: string) {
    return medusaJson<{ type: string; order?: { id: string }; cart?: Cart; error?: { message: string } }>(
      `/store/carts/${cartId}/complete`,
      { method: "POST", auth: true }
    );
  },
};
