export type MoneyAmount = {
  amount?: number;
  currency_code?: string;
};

export type Variant = {
  id: string;
  title: string;
  sku?: string;
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
  handle?: string;
  variants?: Variant[];
};

export type CartItem = {
  id: string;
  title: string;
  quantity: number;
  variant_id?: string;
  unit_price?: number;
};

export type Cart = {
  id: string;
  region_id?: string;
  items?: CartItem[];
  total?: number;
  subtotal?: number;
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
