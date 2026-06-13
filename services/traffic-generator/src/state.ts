/**
 * Shared run-state for the staged pipeline (plan §5). Stage 1 (browse & buy)
 * populates the account and order pools; Stage 2 (post-purchase) draws from them
 * so returns, reorders, order-status, fulfillment, and refunds reference REAL
 * prior state instead of fabricating it.
 *
 * All mutations are synchronous array ops; the bounded-concurrency pool runs
 * cooperatively on a single thread, so no locking is required.
 */

export interface PoolAccount {
  email: string;
  password: string;
  /** Last known customer auth token (refreshed on each login). */
  token?: string;
  customerId?: string;
}

export interface PoolOrderItem {
  /** Order line-item id (required by POST /store/returns). */
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
  /** True once a customer has filed a return against this order. */
  returned?: boolean;
}

export interface PoolReturn {
  orderId: string;
  returnId: string;
  ownerEmail: string;
}

function randomOf<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

export class RunState {
  accountPool: PoolAccount[] = [];
  orderPool: PoolOrder[] = [];
  returnPool: PoolReturn[] = [];
  validPromoCode?: string;

  addAccount(account: PoolAccount): void {
    this.accountPool.push(account);
  }

  /** A random pooled account (returning customers log into these). */
  drawAccount(): PoolAccount | undefined {
    return randomOf(this.accountPool);
  }

  addOrder(order: PoolOrder): void {
    this.orderPool.push(order);
  }

  /** A random completed order, optionally restricted to one owner. */
  drawOrder(ownerEmail?: string): PoolOrder | undefined {
    const candidates = ownerEmail
      ? this.orderPool.filter((o) => o.ownerEmail === ownerEmail)
      : this.orderPool;
    return randomOf(candidates);
  }

  /** A random order that has not yet been returned (for return sessions). */
  drawReturnableOrder(ownerEmail?: string): PoolOrder | undefined {
    const candidates = this.orderPool.filter(
      (o) => !o.returned && (!ownerEmail || o.ownerEmail === ownerEmail)
    );
    return randomOf(candidates);
  }

  addReturn(entry: PoolReturn): void {
    this.returnPool.push(entry);
    const order = this.orderPool.find((o) => o.orderId === entry.orderId);
    if (order) order.returned = true;
  }

  /** A pending return for the admin refund-processing flow to settle. */
  drawReturn(): PoolReturn | undefined {
    return randomOf(this.returnPool);
  }

  get summary() {
    return {
      accounts: this.accountPool.length,
      orders: this.orderPool.length,
      returns: this.returnPool.length,
      validPromo: this.validPromoCode ?? null,
    };
  }
}
