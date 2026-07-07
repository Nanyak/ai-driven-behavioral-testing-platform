/**
 * Evaluation fault catalog (harness side).
 *
 * The mirror of the SUT injector in
 * apps/medusa/apps/backend/src/api/regression-faults.ts. Each entry names a fault
 * the harness will seed (via REGRESSION_DEMO=<id>) and describes, in the report's
 * Bảng-19 vocabulary, which assertion class SHOULD fail when the fault is live.
 * The `id` is the contract with the SUT; the rest is harness-only metadata used
 * to interpret the normalized run result and render the metrics report.
 *
 * Keep `id`s in sync with REGRESSION_FAULT_IDS in the SUT module. A drift is
 * self-announcing: a fault the SUT doesn't recognize simply injects nothing, so
 * the harness reports it "not caught" rather than silently passing.
 */

/** Assertion class expected to fail — mirrors the golden comparison layers
 * (status / schema / business fields) plus the order-status invariant. */
export type FaultClass = "status" | "schema" | "business_field" | "order_status";

export interface EvalFault {
  /** REGRESSION_DEMO value that arms this fault in the SUT. */
  id: string;
  /** Human title for the metrics report. */
  title: string;
  /** Which assertion class the seeded regression should trip. */
  faultClass: FaultClass;
  /**
   * Normalized step endpoint (Playwright step title form, with `{id}`
   * placeholders) whose assertion should flip red. A fault is "caught" iff a
   * failed step on this endpoint appears under the fault but NOT at baseline.
   */
  targetEndpoint: string;
  /** One-line description of the expected regression-report signal. */
  expectedSignal: string;
}

/**
 * All four faults target checkout completion, matching the SUT injector. That
 * endpoint is asserted by the generated customer-checkout spec across status,
 * order-shape, order-totals-balance, and order.status==="pending" layers, so one
 * endpoint exercises four independent assertion classes.
 */
export const FAULT_CATALOG: EvalFault[] = [
  {
    id: "carts_complete_500",
    title: "Checkout completion returns 500",
    faultClass: "status",
    targetEndpoint: "POST /store/carts/{id}/complete",
    expectedSignal: "status assertion (expected 200, received 500) on checkout completion",
  },
  {
    id: "complete_missing_order",
    title: "Completion response drops the order object",
    faultClass: "schema",
    targetEndpoint: "POST /store/carts/{id}/complete",
    expectedSignal: "schema/shape assertion — missing order / order.id on checkout completion",
  },
  {
    id: "order_total_mismatch",
    title: "Order total no longer equals sum(items)",
    faultClass: "business_field",
    targetEndpoint: "POST /store/carts/{id}/complete",
    expectedSignal: "business-field assertion — order totals balance fails on checkout completion",
  },
  {
    id: "order_status_completed",
    title: "New order reports 'completed' instead of 'pending'",
    faultClass: "order_status",
    targetEndpoint: "POST /store/carts/{id}/complete",
    expectedSignal: "order.status invariant (expected 'pending') on checkout completion",
  },
];

export function faultById(id: string): EvalFault | undefined {
  return FAULT_CATALOG.find((f) => f.id === id);
}
