import type { Floors } from "./config.js";
import type { RunState } from "./state.js";
import type { StepResult } from "./api/step.js";
import { SESSION_TYPES, STAGE_OF, type SessionType, type Identity } from "./taxonomy.js";

/** The outcome of one generated session, as consumed by the report tables. */
export interface SessionResult {
  type: SessionType | "signup";
  identity: Identity;
  sessionId: string;
  steps: StepResult[];
}

function bucket(status: number): "2xx" | "3xx" | "4xx" | "5xx" | "err" {
  if (status === 0) return "err";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "err";
}

export function printDistribution(targets: Record<SessionType, number>, results: SessionResult[]): void {
  const header = ["session type", "stg", "target", "real", "reqs", "2xx", "3xx", "4xx", "5xx", "err"];
  const rows: string[][] = [];
  const totals = { target: 0, real: 0, reqs: 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, err: 0 };

  for (const type of SESSION_TYPES) {
    const group = results.filter((r) => r.type === type);
    const counts = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, err: 0 };
    let reqs = 0;
    for (const r of group) {
      for (const step of r.steps) {
        reqs++;
        counts[bucket(step.status)]++;
      }
    }
    rows.push([
      type,
      String(STAGE_OF[type]),
      String(targets[type]),
      String(group.length),
      String(reqs),
      String(counts["2xx"]),
      String(counts["3xx"]),
      String(counts["4xx"]),
      String(counts["5xx"]),
      String(counts.err),
    ]);
    totals.target += targets[type];
    totals.real += group.length;
    totals.reqs += reqs;
    totals["2xx"] += counts["2xx"];
    totals["3xx"] += counts["3xx"];
    totals["4xx"] += counts["4xx"];
    totals["5xx"] += counts["5xx"];
    totals.err += counts.err;
  }

  const totalRow = [
    "TOTAL",
    "-",
    String(totals.target),
    String(totals.real),
    String(totals.reqs),
    String(totals["2xx"]),
    String(totals["3xx"]),
    String(totals["4xx"]),
    String(totals["5xx"]),
    String(totals.err),
  ];

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length), totalRow[i].length)
  );
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log("\nObserved vs target distribution (plan §4)");
  console.log("  " + fmt(header));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log("  " + fmt(row));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  console.log("  " + fmt(totalRow));
}

function countOk(results: SessionResult[], type: SessionType, action: string): number {
  return results.filter(
    (r) => r.type === type && r.steps.some((s) => s.action === action && s.ok)
  ).length;
}

export function printAcceptance(all: SessionResult[], state: RunState, floors: Floors): void {
  const holdout = countOk(all, "newCheckout", "complete_checkout");
  const returningCheckouts = countOk(all, "returningCheckout", "complete_checkout");
  // Returns are admin-filed (the storefront has no customer return endpoint);
  // returnPool holds one entry per confirmed admin return request.
  const returnsFiled = state.returnPool.length;
  const linkedRefunds = state.linkedRefundCount;
  const canceledOrders = state.canceledOrderIds.size;
  const promoSuccess = all.reduce(
    (n, r) => n + (r.steps.some((s) => s.action === "apply_promo" && s.ok) ? 1 : 0),
    0
  );
  // Guest→sign-in conversion pivot: a 401 on `POST /store/carts` (the auth wall)
  // followed by a later 200 on `POST /store/carts` (after login) in the same
  // session — the exact role_observed:[guest, customer] signal (Theme 1).
  const conversionPivots = all.filter((r) => {
    const wall = r.steps.findIndex((s) => s.action === "create_cart" && s.status === 401);
    return wall !== -1 && r.steps.slice(wall + 1).some((s) => s.action === "create_cart" && s.ok);
  }).length;

  const registerNoCheckout = all.filter(
    (r) =>
      r.steps.some((s) => s.action === "register") &&
      !r.steps.some((s) => s.action === "complete_checkout" && s.ok)
  ).length;
  const loginNoRegister = all.filter(
    (r) => r.steps.some((s) => s.action === "login") && !r.steps.some((s) => s.action === "register")
  ).length;

  const flag = (value: number, floor: number) => (value >= floor ? "✓" : "✗");

  console.log("\nAcceptance gates (plan §7)");
  console.log(`  ${flag(holdout, floors.holdout)} holdout (new-customer checkout):   ${holdout} / ≥${floors.holdout}`);
  console.log(`  ${flag(returningCheckouts, floors.returningCheckout)} returning checkouts:           ${returningCheckouts} / ≥${floors.returningCheckout}`);
  console.log(`  ${flag(returnsFiled, floors.returns)} returns filed:                 ${returnsFiled} / ≥${floors.returns}`);
  console.log(`  ${flag(linkedRefunds, floors.linkedRefunds)} cross-role linked refunds:     ${linkedRefunds} / ≥${floors.linkedRefunds}`);
  console.log(`  ${flag(canceledOrders, floors.canceledOrders)} orders canceled (admin):       ${canceledOrders} / ≥${floors.canceledOrders}`);
  console.log(`  ${flag(promoSuccess, floors.promoSuccess)} promo applications (ok):       ${promoSuccess} / ≥${floors.promoSuccess}`);
  console.log(`  ${flag(conversionPivots, 1)} cart-wall conversions (401→login→200): ${conversionPivots} / ≥1`);
  console.log("\nIdentity decoupling (plan §1.4)");
  console.log(`  register-without-checkout sessions: ${registerNoCheckout}`);
  console.log(`  login-without-register sessions:    ${loginNoRegister}`);
  console.log(`  pools: ${JSON.stringify(state.summary)}`);
}
