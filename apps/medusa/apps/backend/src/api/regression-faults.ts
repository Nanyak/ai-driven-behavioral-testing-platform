/**
 * Regression-demo FAULT CATALOG (reversible, OFF by default).
 *
 * A named, individually-toggleable catalog of injected backend regressions used
 * to (a) demo the platform flipping a report green -> red live, and (b) drive the
 * evaluation harness (services/test-runner/src/eval) that MEASURES the generated
 * regression suite's detection rate against known-seeded faults.
 *
 * Selection is via the single env var `REGRESSION_DEMO=<fault_id>`; unset (or an
 * unknown id) means NO fault, so production/CI behavior is unchanged unless the
 * demo explicitly opts in. Toggling a fault requires recreating the Medusa
 * process with the new env value (docker compose up -d --force-recreate medusa) —
 * the injector reads process.env per request, but a separate process's env can
 * only change on restart. The eval harness automates that recreate loop.
 *
 * EVERY catalog fault targets the customer checkout completion
 * (POST /store/carts/{id}/complete), because that single response is asserted by
 * the generated customer-checkout spec across four distinct golden/invariant
 * layers (status, order-shape/schema, order totals balance, order.status ===
 * "pending"). Injecting all four faults at one endpoint keeps the injector a
 * focused response transform while still exercising four independent assertion
 * classes.
 *
 * Fault ids MUST stay in sync with the eval catalog in
 * services/test-runner/src/eval/catalog.ts (that module owns the harness-side
 * metadata + expected-signal for each id). A drift there just surfaces as a fault
 * the harness reports "not caught", so the mismatch is visible, not silent.
 */
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse
} from "@medusajs/framework/http"

/** Every catalog fault id. `carts_complete_500` predates the catalog and keeps
 * its exact original behavior (status-code regression) for the existing demo. */
export const REGRESSION_FAULT_IDS = [
  "carts_complete_500",
  "complete_missing_order",
  "order_total_mismatch",
  "order_status_completed"
] as const

export type RegressionFaultId = (typeof REGRESSION_FAULT_IDS)[number]

/** Amount (in Medusa v2 decimal major units) added to the order total so it no
 * longer equals sum(items)+shipping+tax-discount, tripping the balance invariant
 * and the business-field golden. Large enough to never be a rounding artifact. */
const TOTAL_MISMATCH_DELTA = 1000

function isFaultId(value: string | undefined): value is RegressionFaultId {
  return (
    value !== undefined &&
    (REGRESSION_FAULT_IDS as readonly string[]).includes(value)
  )
}

/** The fault selected by REGRESSION_DEMO for THIS process, or null when none/unknown. */
export function activeRegressionFault(): RegressionFaultId | null {
  const raw = process.env.REGRESSION_DEMO
  return isFaultId(raw) ? raw : null
}

type ResponseMethod = (...args: unknown[]) => unknown
type OrderBody = { order?: Record<string, unknown> } & Record<string, unknown>

/**
 * Pure body transform for the response-mutating faults. Returns a possibly-new
 * body; leaves non-order (cart-shaped failure) bodies untouched so the fault only
 * corrupts a genuine successful completion, never an unrelated shape.
 */
export function mutateCompletionBody(
  faultId: RegressionFaultId,
  body: unknown
): unknown {
  if (faultId === "complete_missing_order") {
    if (body && typeof body === "object" && "order" in body) {
      const { order: _dropped, ...rest } = body as OrderBody
      return rest
    }
    return body
  }

  const order = (body as OrderBody | null)?.order
  if (!order || typeof order !== "object") return body

  if (faultId === "order_total_mismatch") {
    const current = typeof order.total === "number" ? order.total : 0
    return { ...(body as OrderBody), order: { ...order, total: current + TOTAL_MISMATCH_DELTA } }
  }
  if (faultId === "order_status_completed") {
    return { ...(body as OrderBody), order: { ...order, status: "completed" } }
  }
  return body
}

/**
 * Apply the active fault to a POST /store/carts/{id}/complete request. Called by
 * the middleware ONLY for that endpoint under an authenticated customer, so the
 * failure reads as a behavioral regression, never an auth rejection.
 *
 * - carts_complete_500: short-circuit with 500 (response-code regression).
 * - the three body faults: wrap res.json to transform the completion body, then
 *   next() so the real handler runs and its (now-corrupted) body is sent. The
 *   wrapper composes over the structured logger's own res.json wrapper, so the
 *   emitted log captures the faulted body too.
 */
export function applyCompletionFault(
  faultId: RegressionFaultId,
  _req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): void {
  if (faultId === "carts_complete_500") {
    res.status(500).json({
      type: "regression_demo",
      message:
        "Injected fault (regression demo): POST /store/carts/{id}/complete forced to 500."
    })
    return
  }

  const response = res as MedusaResponse & { json: ResponseMethod }
  const originalJson = response.json.bind(res)
  response.json = (...args: unknown[]) => {
    args[0] = mutateCompletionBody(faultId, args[0])
    return originalJson(...args)
  }
  next()
}
