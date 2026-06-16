export type MoneyAmount = {
  amount?: number;
  currency_code?: string;
};

export type Variant = {
  id: string;
  title: string;
  sku?: string;
  inventory_quantity?: number | null;
  manage_inventory?: boolean;
  calculated_price?: {
    calculated_amount?: number;
    currency_code?: string;
    original_amount?: number;
  };
  prices?: MoneyAmount[];
};

export type Product = {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  thumbnail?: string;
  images?: Array<{
    id?: string;
    url?: string;
  }>;
  handle?: string;
  collection?: {
    id?: string;
    title?: string;
  };
  tags?: Array<{
    id?: string;
    value?: string;
  }>;
  variants?: Variant[];
};

export type CartItem = {
  id: string;
  title: string;
  quantity: number;
  variant_id?: string;
  unit_price?: number;
};

export type CheckoutAddress = {
  id?: string;
  label?: string;
  email: string;
  first_name: string;
  last_name: string;
  address_1: string;
  city: string;
  postal_code: string;
  country_code: string;
  phone: string;
};

export type Cart = {
  id: string;
  region_id?: string;
  items?: CartItem[];
  total?: number;
  subtotal?: number;
  discount_total?: number;
  shipping_total?: number;
  tax_total?: number;
  currency_code?: string;
  email?: string;
  shipping_address?: {
    address_1?: string;
    city?: string;
    country_code?: string;
    postal_code?: string;
  };
  shipping_methods?: Array<{
    id: string;
    name?: string;
    amount?: number;
    shipping_option_id?: string;
  }>;
  payment_collection?: {
    id: string;
    payment_sessions?: Array<{
      id: string;
      provider_id?: string;
      status?: string;
    }>;
  };
};

export type ProductReview = {
  id: string;
  product_id: string;
  author: string;
  rating: number;
  title: string;
  body: string;
  created_at: string;
};

export type ProductQuestion = {
  id: string;
  product_id: string;
  author: string;
  question: string;
  answer?: string;
  created_at: string;
};

export type StoreNotification = {
  id: string;
  title: string;
  body: string;
  type: "cart" | "order" | "account" | "promo" | "support";
  read: boolean;
  created_at: string;
};

export type Order = {
  id: string;
  display_id?: number;
  email?: string;
  created_at?: string;
  currency_code?: string;
  total?: number;
  subtotal?: number;
  shipping_total?: number;
  tax_total?: number;
  status?: string;
  payment_status?: string;
  fulfillment_status?: string;
  items?: CartItem[];
  shipping_methods?: Cart["shipping_methods"];
};

export type OrderListResult = {
  orders: Order[];
  count?: number;
  limit?: number;
  offset?: number;
};

export type Region = {
  id: string;
  name: string;
  currency_code?: string;
};

export type Customer = {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
};

export type ShippingOption = {
  id: string;
  name: string;
  amount?: number;
};

export type PaymentProvider = {
  id: string;
  is_enabled?: boolean;
};
