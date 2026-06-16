/**
 * Shared run-state for the staged pipeline (plan §5). Stage 1 (browse & buy)
 * populates the account and order pools; Stage 2 (post-purchase) draws from them
 * so returns, reorders, order-status, fulfillment, and refunds reference REAL
 * prior state instead of fabricating it.
 *
 * All mutations are synchronous array ops; the bounded-concurrency pool runs
 * cooperatively on a single thread, so no locking is required.
 */

import { pick } from "../util/random.js";

export interface PoolAccount {
  email: string;
  password: string;
  /** Last known customer auth token (refreshed on each login). */
  token?: string;
  customerId?: string;
}

export interface PoolOrderItem {
  /** Cart line-item id (used for reorder/buy-again; admin returns resolve order
   * line-item ids fresh from the backend). */
  id: string;
  quantity: number;
  variantId?: string;
}

export interface PoolOrder {
  orderId: string;
  ownerEmail: string;
  token?: string;
  items: PoolOrderItem[];
  regionId?: string;
  /** True once a customer has inquired about returning this order (Stage-2 E
   * flow). The storefront has no customer return endpoint, so this is a
   * read-only signal that flags the order for admin-side settlement. */
  returnRequested?: boolean;
  /** Claimed by an in-flight admin fulfillment (F2) — prevents a concurrent
   * session double-fulfilling the same order. */
  fulfillClaimed?: boolean;
  /** True once an admin has fulfilled the order (F2). Returns require fulfilled
   * items; cancels only apply to UNFULFILLED orders. */
  fulfilled?: boolean;
  /** Claimed by an in-flight Stage-2b reversal (return or cancel) — an order
   * gets at most one reversal. */
  claimed?: boolean;
  /** True once an admin has filed a return against this order (Stage-2 F3). */
  returned?: boolean;
  /** True once an admin has canceled this order (Stage-2 F5). */
  canceled?: boolean;
}

export interface PoolReturn {
  orderId: string;
  returnId: string;
  ownerEmail: string;
}

export class RunState {
  accountPool: PoolAccount[] = [];
  orderPool: PoolOrder[] = [];
  returnPool: PoolReturn[] = [];
  /** order_ids an admin has refunded — joined against returnPool for linkage. */
  refundedOrderIds = new Set<string>();
  /** order_ids an admin canceled (unfulfilled-order reversal path). */
  canceledOrderIds = new Set<string>();
  /** order_ids whose customer-filed return an admin REJECTED (Theme 4c) — a
   * pooled order whose return was declined rather than refunded. */
  rejectedReturnOrderIds = new Set<string>();
  validPromoCode?: string;
  /** Variant id of the dedicated limited-stock product (Theme 3 stock-out arc),
   * created once in Stage 0. Unset if create-product failed — the stockOutCheckout
   * dispatch then degrades to a normal returning browse (never hard-fails). */
  lowStockVariantId?: string;
  /** Product id of the limited-stock product — for the stock-out flow's viewProduct. */
  lowStockProductId?: string;
  /** The pinned stocked quantity of the low-stock product, so the flow can add
   * `stock + 1` to trigger the insufficient-inventory 400 deterministically. */
  lowStockQty?: number;

  addAccount(account: PoolAccount): void {
    this.accountPool.push(account);
  }

  /** A random pooled account (returning customers log into these). */
  drawAccount(): PoolAccount | undefined {
    return pick(this.accountPool);
  }

  addOrder(order: PoolOrder): void {
    this.orderPool.push(order);
  }

  /** A random completed order, optionally restricted to one owner. */
  drawOrder(ownerEmail?: string): PoolOrder | undefined {
    const candidates = ownerEmail
      ? this.orderPool.filter((o) => o.ownerEmail === ownerEmail)
      : this.orderPool;
    return pick(candidates);
  }

  // --- Stage-2a: fulfillment (F2) -------------------------------------------

  /**
   * Claim an unfulfilled order for the admin fulfillment flow. Claims
   * synchronously so concurrent F2 sessions don't double-fulfill one order.
   */
  drawForFulfill(): PoolOrder | undefined {
    const order = pick(this.orderPool.filter((o) => !o.fulfillClaimed && !o.canceled));
    if (order) order.fulfillClaimed = true;
    return order;
  }

  /** Record a successful fulfillment — the order is now returnable. */
  markFulfilled(orderId: string): void {
    const order = this.orderPool.find((o) => o.orderId === orderId);
    if (order) order.fulfilled = true;
  }

  // --- Stage-2b: customer return inquiry (E) --------------------------------

  /**
   * A fulfilled order owned by a pooled account, for the customer return
   * inquiry. Customers only inquire about orders they actually received, so the
   * inquiry targets fulfilled orders (which an admin can then return/refund).
   */
  drawFulfilledOwnedOrder(): PoolOrder | undefined {
    return pick(
      this.orderPool.filter(
        (o) =>
          o.fulfilled &&
          !o.canceled &&
          this.accountPool.some((a) => a.email === o.ownerEmail)
      )
    );
  }

  /** Mark that a customer inquired about returning this order (Stage-2 E). */
  markReturnRequested(orderId: string): void {
    const order = this.orderPool.find((o) => o.orderId === orderId);
    if (order) order.returnRequested = true;
  }

  // --- Stage-2b: admin reversals (F3 return / F5 cancel) --------------------

  /**
   * Claim a fulfilled order for the admin return/refund flow (F3), preferring
   * orders a customer inquired about (the cross-role touch). Returns require
   * fulfilled items, so the candidate set is the Stage-2a fulfilled orders.
   */
  drawReturnable(): PoolOrder | undefined {
    const fulfilled = this.orderPool.filter((o) => o.fulfilled && !o.claimed && !o.canceled);
    const inquired = fulfilled.filter((o) => o.returnRequested);
    const order = pick(inquired.length ? inquired : fulfilled);
    if (order) order.claimed = true;
    return order;
  }

  /**
   * Claim a fulfilled order for the admin return-REJECT flow (Theme 4c / F6),
   * preferring orders a customer inquired about (the cross-role touch). Like
   * drawReturnable() it requires a fulfilled order (the reject flow first files a
   * return, which needs fulfilled items) and claims synchronously so a single
   * order never gets both a refund (F3) and a rejection.
   */
  drawRejectable(): PoolOrder | undefined {
    const fulfilled = this.orderPool.filter((o) => o.fulfilled && !o.claimed && !o.canceled);
    const inquired = fulfilled.filter((o) => o.returnRequested);
    const order = pick(inquired.length ? inquired : fulfilled);
    if (order) order.claimed = true;
    return order;
  }

  /**
   * Claim an UNFULFILLED order for the admin cancel flow (F5) — the natural
   * reversal before an order ships. A fulfilled order cannot be canceled
   * directly on this build, so those are excluded.
   */
  drawCancelable(): PoolOrder | undefined {
    const order = pick(
      this.orderPool.filter((o) => !o.fulfilled && !o.fulfillClaimed && !o.claimed && !o.canceled)
    );
    if (order) order.claimed = true;
    return order;
  }

  addReturn(entry: PoolReturn): void {
    this.returnPool.push(entry);
    const order = this.orderPool.find((o) => o.orderId === entry.orderId);
    if (order) order.returned = true;
  }

  /** Record that an admin refunded this order (for cross-role linkage). */
  markRefunded(orderId: string): void {
    this.refundedOrderIds.add(orderId);
  }

  /** Record that an admin canceled this order (unfulfilled-order reversal). */
  markCanceled(orderId: string): void {
    this.canceledOrderIds.add(orderId);
    const order = this.orderPool.find((o) => o.orderId === orderId);
    if (order) order.canceled = true;
  }

  /** Record that an admin REJECTED a customer-filed return on this order
   * (Theme 4c). The order stays fulfilled and uncanceled — only the return was
   * declined — so it is tracked separately from the refund/cancel sets. */
  markReturnRejected(orderId: string): void {
    this.rejectedReturnOrderIds.add(orderId);
  }

  /** order_ids that were both returned and refunded by an admin (full F3
   * lifecycle) — the cross-role linkage Phase 7 joins on (customer placed the
   * order, admin reversed it). */
  get linkedRefundCount(): number {
    const returned = new Set(this.returnPool.map((r) => r.orderId));
    let n = 0;
    for (const id of this.refundedOrderIds) if (returned.has(id)) n++;
    return n;
  }

  get summary() {
    return {
      accounts: this.accountPool.length,
      orders: this.orderPool.length,
      returns: this.returnPool.length,
      refunds: this.refundedOrderIds.size,
      cancels: this.canceledOrderIds.size,
      rejectedReturns: this.rejectedReturnOrderIds.size,
      validPromo: this.validPromoCode ?? null,
    };
  }
}
