import type {
  Cart,
  Customer,
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
    "x-persona": "guest_shopper",
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
      fields: "*variants.calculated_price",
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
      body: JSON.stringify({ region_id: regionId }),
    });

    return created.cart;
  },

  async getCart(cartId: string) {
    const latestCart = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}`);
    return latestCart.cart;
  },

  async addLineItem(cartId: string, variantId: string, quantity = 1) {
    const updated = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}/line-items`, {
      method: "POST",
      body: JSON.stringify({
        variant_id: variantId,
        quantity,
      }),
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

  async updateCheckoutAddress(cartId: string, email: string, firstName: string, lastName: string) {
    const withAddress = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}`, {
      method: "POST",
      body: JSON.stringify({
        email,
        shipping_address: {
          first_name: firstName,
          last_name: lastName,
          address_1: "Test Street 1",
          city: "Copenhagen",
          postal_code: "1000",
          country_code: "dk",
          phone: "12345678",
        },
        billing_address: {
          first_name: firstName,
          last_name: lastName,
          address_1: "Test Street 1",
          city: "Copenhagen",
          postal_code: "1000",
          country_code: "dk",
          phone: "12345678",
        },
      }),
    });

    return withAddress.cart;
  },

  async addShippingMethod(cartId: string, optionId: string) {
    const withShipping = await medusaJson<{ cart: Cart }>(`/store/carts/${cartId}/shipping-methods`, {
      method: "POST",
      body: JSON.stringify({ option_id: optionId }),
    });
    return withShipping.cart;
  },

  async createPaymentCollection(cartId: string) {
    const paymentCollection = await medusaJson<{ payment_collection: Cart["payment_collection"] }>(
      "/store/payment-collections",
      {
        method: "POST",
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
        body: JSON.stringify({ provider_id: providerId, data: {} }),
      }
    );

    return payment.payment_collection;
  },

  async completeCart(cartId: string) {
    return medusaJson<{ type: string; order?: { id: string }; cart?: Cart; error?: { message: string } }>(
      `/store/carts/${cartId}/complete`,
      { method: "POST" }
    );
  },
};
