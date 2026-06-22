/**
 * Stage 1 (browse & buy) populates the account and order pools; Stage 2
 * (post-purchase) draws from them so returns, reorders, order-status,
 * fulfillment, and refunds reference REAL prior state instead of fabricating it.
 *
 * All mutations are synchronous array ops; the bounded-concurrency pool runs
 * cooperatively on a single thread, so no locking is required.
 */

import { pick } from "../util/random.js";

export interface PoolAccount {
  email: string;
  password: string;
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
  /** The storefront has no customer return endpoint, so this is a read-only
   * signal that flags the order for admin-side settlement. */
  returnRequested?: boolean;
  /** Prevents a concurrent session double-fulfilling the same order. */
  fulfillClaimed?: boolean;
  /** Returns require fulfilled items; cancels only apply to UNFULFILLED orders. */
  fulfilled?: boolean;
  /** An order gets at most one reversal (return or cancel). */
  claimed?: boolean;
  returned?: boolean;
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
  rejectedReturnOrderIds = new Set<string>();
  validPromoCode?: string;
  /** Unset if create-product failed — the stockOutCheckout dispatch then
   * degrades to a normal returning browse (never hard-fails). */
  lowStockVariantId?: string;
  lowStockProductId?: string;
  /** So the flow can add `stock + 1` to trigger the insufficient-inventory 400
   * deterministically. */
  lowStockQty?: number;

  addAccount(account: PoolAccount): void {
    this.accountPool.push(account);
  }

  drawAccount(): PoolAccount | undefined {
    return pick(this.accountPool);
  }

  addOrder(order: PoolOrder): void {
    this.orderPool.push(order);
  }

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

  markFulfilled(orderId: string): void {
    const order = this.orderPool.find((o) => o.orderId === orderId);
    if (order) order.fulfilled = true;
  }

  // --- Stage-2b: customer return inquiry (E) --------------------------------

  /** Customers only inquire about orders they actually received, so the
   * inquiry targets fulfilled orders (which an admin can then return/refund). */
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

  /** For cross-role linkage. */
  markRefunded(orderId: string): void {
    this.refundedOrderIds.add(orderId);
  }

  markCanceled(orderId: string): void {
    this.canceledOrderIds.add(orderId);
    const order = this.orderPool.find((o) => o.orderId === orderId);
    if (order) order.canceled = true;
  }

  /** The order stays fulfilled and uncanceled — only the return was declined —
   * so it is tracked separately from the refund/cancel sets. */
  markReturnRejected(orderId: string): void {
    this.rejectedReturnOrderIds.add(orderId);
  }

  /** The cross-role linkage Phase 7 joins on (customer placed the order, admin
   * reversed it). */
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
