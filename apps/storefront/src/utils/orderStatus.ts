import type { Order } from "../types/storefront";

// Shopee-style order stages, ordered the way the tabs read left-to-right.
export type OrderStage = "to_pay" | "to_ship" | "shipping" | "to_receive" | "completed" | "cancelled";

export const ORDER_STAGES: OrderStage[] = [
  "to_pay",
  "to_ship",
  "shipping",
  "to_receive",
  "completed",
  "cancelled",
];

export const ORDER_STAGE_LABEL: Record<OrderStage, string> = {
  to_pay: "To pay",
  to_ship: "To ship",
  shipping: "Shipping",
  to_receive: "To receive",
  completed: "Completed",
  cancelled: "Cancelled",
};

// Maps a Medusa order's status/payment/fulfillment fields onto a single
// customer-facing stage. Mirrors Shopee's "what do I do next" framing rather
// than Medusa's internal status taxonomy.
export function deriveOrderStage(order: Order): OrderStage {
  const status = order.status;
  const fulfillment = order.fulfillment_status;
  const payment = order.payment_status;

  if (status === "canceled" || fulfillment === "canceled") {
    return "cancelled";
  }

  if (status === "completed") {
    return "completed";
  }

  if (fulfillment === "delivered" || fulfillment === "partially_delivered") {
    return "to_receive";
  }

  if (fulfillment === "shipped" || fulfillment === "partially_shipped") {
    return "shipping";
  }

  if (payment === "not_paid" || payment === "awaiting" || status === "requires_action") {
    return "to_pay";
  }

  return "to_ship";
}

// Re-order is offered on finished orders (completed or cancelled). Order
// lifecycle actions (cancel / refund / return) are intentionally NOT exposed to
// the storefront: Medusa has no customer-facing endpoint for them, so they are
// handled by an admin in the Medusa admin dashboard.
export function canBuyAgain(stage: OrderStage): boolean {
  return stage === "completed" || stage === "cancelled";
}
