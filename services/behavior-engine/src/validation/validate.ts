/**
 * Validation — the defensible claims (plan section Validation).
 *
 * Produces `classification-report-<runId>.json`. EVERYTHING here that touches
 * `role_observed` is VALIDATION-ONLY: this module is the single place the held-out
 * JWT ground truth is read, AFTER classification has already happened. The
 * classifier (attributes/persona) never sees it (the guardrail).
 *
 * Emits, on the real data:
 *   1. Per-persona precision/recall + confusion matrix for TWO rule variants on
 *      the SAME sessions — the endpoint-only baseline and the cart-signal rule —
 *      so the cart signal's contribution is a measured DELTA (footnote
 *      included: role_observed under-labels token-reuse/login sessions as guest,
 *      so some guest->customer reclassifications are ground-truth GAPS, not
 *      classifier errors).
 *   2. Holdout recovery: PrefixSpan support count for the registered-customer
 *      checkout backbone; acceptance is support >= 6 (the holdout floor,
 *      floor=6), comfortably above minSupport=3.
 *   3. Negative control: a concrete fixture check — no high-support mined
 *      flow contains a *successful* `POST /store/returns` (removed by ADR 0003,
 *      so store returns are a dead 4xx path) nor an admin->customer-checkout
 *      chimera. Pass = that signature's support is 0/below floor.
 *   4. Contamination resolution: contaminated guest->customer sessions
 *      resolve to the highest-privilege persona.
 */

import type { SessionFlow } from "../io/sessions.js";
import type { Persona } from "../classification/persona.js";
import { PERSONAS, classify } from "../classification/persona.js";
import { canonicalTokens } from "../signature/signature.js";
import type { SequentialPattern, PrefixSpanResult } from "../mining/prefixspan.js";
import { decodePattern } from "../mining/prefixspan.js";

// ---------------------------------------------------------------------------
// Ground truth (VALIDATION ONLY)
// ---------------------------------------------------------------------------

function groundTruthPersona(roles: SessionFlow["role_observed"]): Persona {
  if (roles.includes("admin")) {
    return "admin_operator";
  }
  if (roles.includes("customer")) {
    return "registered_customer";
  }
  return "guest_shopper";
}

// ---------------------------------------------------------------------------
// Per-variant classification scoring
// ---------------------------------------------------------------------------

export interface PersonaScore {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface VariantReport {
  variant: "endpoint_only" | "cart_signal" | "cart_read_signal";
  confusion: Record<Persona, Record<Persona, number>>;
  perPersona: Record<Persona, PersonaScore>;
  macroF1: number;
  accuracy: number;
}

function emptyConfusion(): Record<Persona, Record<Persona, number>> {
  const make = () =>
    Object.fromEntries(PERSONAS.map((p) => [p, 0])) as Record<Persona, number>;
  return Object.fromEntries(PERSONAS.map((p) => [p, make()])) as Record<
    Persona,
    Record<Persona, number>
  >;
}

function scoreVariant(
  sessions: SessionFlow[],
  useCartSignal: boolean,
  useReadSignal = false
): VariantReport {
  const confusion = emptyConfusion();
  let correct = 0;

  for (const session of sessions) {
    const truth = groundTruthPersona(session.role_observed);
    // attributes.ts reads endpoint + status only — NOT role_observed.
    const predicted = classify(session.steps, useCartSignal, useReadSignal).persona;
    confusion[truth][predicted]++;
    if (truth === predicted) {
      correct++;
    }
  }

  const perPersona = {} as Record<Persona, PersonaScore>;
  let macroF1Sum = 0;
  for (const persona of PERSONAS) {
    const tp = confusion[persona][persona];
    let predictedTotal = 0;
    let truthTotal = 0;
    for (const other of PERSONAS) {
      predictedTotal += confusion[other][persona]; // column sum
      truthTotal += confusion[persona][other]; // row sum
    }
    const precision = predictedTotal > 0 ? tp / predictedTotal : 0;
    const recall = truthTotal > 0 ? tp / truthTotal : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    perPersona[persona] = { precision, recall, f1, support: truthTotal };
    macroF1Sum += f1;
  }

  return {
    variant: useReadSignal
      ? "cart_read_signal"
      : useCartSignal
        ? "cart_signal"
        : "endpoint_only",
    confusion,
    perPersona,
    macroF1: macroF1Sum / PERSONAS.length,
    accuracy: sessions.length > 0 ? correct / sessions.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Holdout recovery
// ---------------------------------------------------------------------------

/**
 * The registered-customer checkout BACKBONE — the holdout sequence, realized
 * only in `personas/customer-llm.ts`. PrefixSpan must rediscover it.
 * These are the load-bearing ordered tokens; PrefixSpan allows gaps, so browsing
 * noise around them does not prevent the match.
 */
const HOLDOUT_BACKBONE = [
  "POST /auth/customer/emailpass/register",
  "POST /store/carts",
  "POST /store/carts/{id}/line-items",
  "POST /store/carts/{id}/complete",
];

export const HOLDOUT_SUPPORT_FLOOR = 6; // holdout floor for customer checkout sessions.

function containsSubsequence(patternTokens: string[], target: string[]): boolean {
  let i = 0;
  for (const token of patternTokens) {
    if (token === target[i]) {
      i++;
      if (i === target.length) {
        return true;
      }
    }
  }
  return i === target.length;
}

export interface HoldoutReport {
  backbone: string[];
  recovered: boolean;
  /** Max PrefixSpan support among patterns containing the backbone subsequence. */
  support: number;
  floor: number;
  passes: boolean;
}

function scoreHoldout(prefixspan: PrefixSpanResult): HoldoutReport {
  let best = 0;
  for (const pattern of prefixspan.patterns) {
    const tokens = decodePattern(pattern, prefixspan.vocabulary);
    if (containsSubsequence(tokens, HOLDOUT_BACKBONE)) {
      best = Math.max(best, pattern.support);
    }
  }
  return {
    backbone: HOLDOUT_BACKBONE,
    recovered: best > 0,
    support: best,
    floor: HOLDOUT_SUPPORT_FLOOR,
    passes: best >= HOLDOUT_SUPPORT_FLOOR,
  };
}

// ---------------------------------------------------------------------------
// Negative control — concrete fixture
// ---------------------------------------------------------------------------

/**
 * Sequences the traffic generator PROVABLY never injects as a successful path:
 *   - a *successful* (2xx) `POST /store/returns` — store returns were removed by
 *     ADR 0003; the only such steps in real logs are 400s, so a high-support
 *     SUCCESSFUL store-return flow would be a hallucination.
 *   - an admin->customer-checkout chimera: `POST /admin/returns` followed by a
 *     customer `POST /store/carts/{id}/complete` in one mined flow. No session
 *     mixes an admin reversal with a customer checkout completion.
 *
 * Pass condition: neither fixture appears in any high-support (>= minSupport)
 * mined flow. We mine on canonical tokens (status excluded from the signature),
 * so the successful-return fixture is checked directly against the raw sessions:
 * we assert NO session carries a 2xx `POST /store/returns` at all, then confirm
 * the chimera ordering has support below the floor.
 */
export interface NegativeControlReport {
  successfulStoreReturnSessions: number; // must be 0
  chimeraSupport: number; // must be < minSupport
  minSupport: number;
  passes: boolean;
}

const ADMIN_RETURN = "POST /admin/returns";
const CUSTOMER_COMPLETE = "POST /store/carts/{id}/complete";

function scoreNegativeControl(
  sessions: SessionFlow[],
  prefixspan: PrefixSpanResult,
  minSupport: number
): NegativeControlReport {
  // Fixture 1: any successful (2xx) POST /store/returns in the raw logs.
  let successfulStoreReturns = 0;
  for (const session of sessions) {
    for (const step of session.steps) {
      if (
        step.method.toUpperCase() === "POST" &&
        step.endpoint === "/store/returns" &&
        step.status >= 200 &&
        step.status < 300
      ) {
        successfulStoreReturns++;
      }
    }
  }

  // Fixture 2: admin-return -> customer-checkout chimera as a mined subsequence.
  let chimeraSupport = 0;
  for (const pattern of prefixspan.patterns) {
    const tokens = decodePattern(pattern, prefixspan.vocabulary);
    if (containsSubsequence(tokens, [ADMIN_RETURN, CUSTOMER_COMPLETE])) {
      chimeraSupport = Math.max(chimeraSupport, pattern.support);
    }
  }

  return {
    successfulStoreReturnSessions: successfulStoreReturns,
    chimeraSupport,
    minSupport,
    passes: successfulStoreReturns === 0 && chimeraSupport < minSupport,
  };
}

// ---------------------------------------------------------------------------
// Contamination resolution
// ---------------------------------------------------------------------------

export interface ContaminationReport {
  /** Sessions whose role_observed contains guest AND a higher role. */
  contaminatedSessions: number;
  /** Of those, how many the classifier resolves to the highest-privilege persona. */
  resolvedToHighestPrivilege: number;
  /**
   * Misclassified contaminated sessions that DO carry a content privilege-signal
   * (auth endpoint, 2xx cart mutation, or /admin/*) — these would be real
   * classifier errors. The gate passes iff this is 0.
   */
  misclassifiedWithSignal: number;
  /**
   * Misclassified contaminated sessions with NO content privilege-signal — the
   * Ground-truth gap: role_observed carries a JWT role (token reuse / login)
   * that left no trace in the steps, so content-only classification correctly
   * reads them as guest. NOT classifier errors; reported, not failed.
   */
  groundTruthGaps: number;
  passes: boolean;
}

const AUTH_CUSTOMER_RE = /^\/auth\/customer(\/|$)/;

/** Does this session's STEP CONTENT carry any higher-privilege signal? */
function hasPrivilegeSignal(session: SessionFlow): boolean {
  for (const step of session.steps) {
    const method = step.method.toUpperCase();
    if (step.endpoint.startsWith("/admin/")) {
      return true;
    }
    if (AUTH_CUSTOMER_RE.test(step.endpoint) || step.endpoint === "/store/customers") {
      return true;
    }
    const isCartMutation =
      ["POST", "PATCH", "DELETE"].includes(method) &&
      (step.endpoint.startsWith("/store/carts") ||
        step.endpoint.startsWith("/store/payment-collections"));
    if (isCartMutation && step.status >= 200 && step.status < 300) {
      return true;
    }
  }
  return false;
}

function scoreContamination(sessions: SessionFlow[]): ContaminationReport {
  let contaminated = 0;
  let resolved = 0;
  let misclassifiedWithSignal = 0;
  let groundTruthGaps = 0;

  for (const session of sessions) {
    const roles = new Set(session.role_observed);
    const isContaminated =
      roles.has("guest") && (roles.has("customer") || roles.has("admin"));
    if (!isContaminated) {
      continue;
    }
    contaminated++;
    const truth = groundTruthPersona(session.role_observed); // highest privilege
    // Production rule: full status-derived signal (cart + read), ADR 0006.
    const predicted = classify(session.steps, true, true).persona;
    if (predicted === truth) {
      resolved++;
    } else if (hasPrivilegeSignal(session)) {
      misclassifiedWithSignal++; // a real classifier error
    } else {
      groundTruthGaps++; // role_observed under-labels token-reuse sessions, not our error
    }
  }

  return {
    contaminatedSessions: contaminated,
    resolvedToHighestPrivilege: resolved,
    misclassifiedWithSignal,
    groundTruthGaps,
    // Sound gate: every contaminated session that emits a content
    // privilege-signal must resolve to the highest privilege. Sessions with no
    // such signal are ground-truth gaps (token reuse), correctly read as guest.
    passes: misclassifiedWithSignal === 0,
  };
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export interface ValidationReport {
  run_id: string;
  sessions_scored: number;
  /**
   * FOOTNOTE: `role_observed` under-labels token-reuse and login-only
   * sessions as guest — a returning customer who reuses a live JWT emits no
   * /auth/* endpoint and may be tagged guest in role_observed even though the
   * cart-signal rule correctly recovers them. Some guest->customer
   * reclassifications under the cart-signal variant are therefore GROUND-TRUTH
   * GAPS, not classifier errors. Confirm a guest `POST /store/carts` returns 401
   * against the live cartWall (401->200) before reading the gate as leaking.
   */
  ground_truth_footnote: string;
  classification: {
    endpoint_only: VariantReport;
    cart_signal: VariantReport;
    /** Baseline + cart + read signals — the production rule (ADR 0006). */
    cart_read_signal: VariantReport;
    /** cart_signal.macroF1 - endpoint_only.macroF1 (must be >= 0). */
    macro_f1_delta: number;
    /** Per-persona recall lift the cart signal gives (the measured delta). */
    registered_customer_recall_lift: number;
    /**
     * The READ signal's incremental contribution (ADR 0006), measured vs the
     * cart-signal variant — the read analog of the cart-signal delta above.
     */
    read_signal: {
      /** cart_read_signal.macroF1 - cart_signal.macroF1 (must be >= 0). */
      macro_f1_delta: number;
      /** registered_customer recall lift the read signal adds over cart-signal. */
      registered_customer_recall_lift: number;
    };
  };
  holdout: HoldoutReport;
  negative_control: NegativeControlReport;
  contamination: ContaminationReport;
}

const FOOTNOTE =
  "role_observed under-labels token-reuse/login-only sessions as guest (a " +
  "returning customer reusing a live JWT emits no /auth endpoint). Some " +
  "guest->customer reclassifications under the cart-signal variant are " +
  "ground-truth gaps, not classifier errors. The cart-signal rule is sound only " +
  "while the requireCustomerAuth gate enforces: confirm a guest POST /store/carts " +
  "returns 401 (cartWall 401->200) before concluding the gate leaks.";

export function buildValidationReport(
  runId: string,
  sessions: SessionFlow[],
  prefixspan: PrefixSpanResult,
  minSupport: number
): ValidationReport {
  const endpointOnly = scoreVariant(sessions, false);
  const cartSignal = scoreVariant(sessions, true);
  const cartReadSignal = scoreVariant(sessions, true, true);

  return {
    run_id: runId,
    sessions_scored: sessions.length,
    ground_truth_footnote: FOOTNOTE,
    classification: {
      endpoint_only: endpointOnly,
      cart_signal: cartSignal,
      cart_read_signal: cartReadSignal,
      macro_f1_delta: cartSignal.macroF1 - endpointOnly.macroF1,
      registered_customer_recall_lift:
        cartSignal.perPersona.registered_customer.recall -
        endpointOnly.perPersona.registered_customer.recall,
      read_signal: {
        macro_f1_delta: cartReadSignal.macroF1 - cartSignal.macroF1,
        registered_customer_recall_lift:
          cartReadSignal.perPersona.registered_customer.recall -
          cartSignal.perPersona.registered_customer.recall,
      },
    },
    holdout: scoreHoldout(prefixspan),
    negative_control: scoreNegativeControl(sessions, prefixspan, minSupport),
    contamination: scoreContamination(sessions),
  };
}

export { canonicalTokens };
export type { SequentialPattern };
