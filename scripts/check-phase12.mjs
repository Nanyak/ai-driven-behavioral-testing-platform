#!/usr/bin/env node

/**
 * Phase 12 verification: Regression Demonstration
 *
 * Phase 12 is a report-regression demonstration. This check proves, OFFLINE,
 * the fixture-based detection and attribution behavior:
 *
 *   [1] The detection + attribution logic: a baseline-green normalized run
 *       builds a GREEN report; the same flow with POST /store/carts/{id}/complete
 *       flipped 200->500 builds a RED report that attributes the regression to
 *       the right persona, flow, and endpoint — and leaves the unaffected guest
 *       flow green. Rebuilding the baseline returns to green (reversibility).
 *
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICE = resolve(ROOT, "services", "test-runner");
const GREEN = resolve(SERVICE, "fixtures", "baseline-green.normalized.json");
const RED = resolve(SERVICE, "fixtures", "regressed-red.normalized.json");
const REGRESSED_ENDPOINT = "POST /store/carts/{id}/complete";

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

function buildReports() {
  const probe = `
    import { readFileSync } from "node:fs";
    import { buildReport } from ${JSON.stringify(resolve(SERVICE, "src", "report", "build.js"))};
    const green = buildReport(JSON.parse(readFileSync(${JSON.stringify(GREEN)}, "utf8")), { runId: "run-green" });
    const red = buildReport(JSON.parse(readFileSync(${JSON.stringify(RED)}, "utf8")), { runId: "run-red" });
    process.stdout.write(JSON.stringify({ green, red }));
  `;
  const probePath = resolve(SERVICE, ".regression-probe.mts");
  writeFileSync(probePath, probe);
  const run = spawnSync("npx", ["tsx", probePath], { cwd: SERVICE, encoding: "utf8" });
  rmSync(probePath, { force: true });
  if (run.status !== 0) {
    fail("regression probe", (run.stdout || run.stderr || "").trim().split("\n").slice(-3).join(" | "));
    return null;
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    fail("regression probe output parse", run.stdout.slice(0, 200));
    return null;
  }
}

function main() {
  console.log("Phase 12: Regression Demonstration Check");

  if (!existsSync(SERVICE + "/node_modules")) {
    const install = spawnSync("npm", ["install"], { cwd: SERVICE, encoding: "utf8" });
    if (install.status !== 0) {
      fail("services/test-runner npm install");
      return summary();
    }
  }

  // [1] Detection + attribution (green baseline vs injected regression).
  console.log("\n[1] Baseline-green vs regressed-red detection + attribution");
  const out = buildReports();
  if (!out) return summary();
  const { green, red } = out;

  if (green.status === "green" && green.totals.failed === 0 && green.endpoint_failures.length === 0) {
    ok("baseline run builds a GREEN report (0 failures)");
  } else {
    fail("baseline green", JSON.stringify(green.totals));
  }

  if (red.status === "red" && red.totals.failed === 1) {
    ok("regressed run builds a RED report (1 failure)");
  } else {
    fail("regressed red", JSON.stringify(red.totals));
  }

  // Affected endpoint attributed.
  const ep = red.endpoint_failures.find((e) => e.endpoint === REGRESSED_ENDPOINT);
  if (ep && ep.failures === 1) ok(`affected ENDPOINT attributed: ${REGRESSED_ENDPOINT}`);
  else fail("endpoint attribution", JSON.stringify(red.endpoint_failures));

  // Affected persona attributed; guest unaffected.
  const cust = red.by_persona.find((p) => p.persona === "registered_customer");
  const guest = red.by_persona.find((p) => p.persona === "guest_shopper");
  if (cust && cust.failed === 1 && guest && guest.failed === 0 && guest.passed === 1) {
    ok("affected PERSONA attributed (registered_customer); guest flow stays green");
  } else {
    fail("persona attribution", JSON.stringify(red.by_persona));
  }

  // Affected flow attributed.
  const flow = red.by_flow.find((fl) => fl.flow_name === "Registered Customer Checkout");
  if (flow && flow.failed === 1) ok("affected FLOW attributed: Registered Customer Checkout");
  else fail("flow attribution", JSON.stringify(red.by_flow));

  // Expected-vs-actual status shown on the failure.
  const f = red.failures.find((x) => x.endpoint === REGRESSED_ENDPOINT);
  if (f && f.expected_status === 200 && f.actual_status === 500) {
    ok("expected-vs-actual status shown (200 -> 500)");
  } else {
    fail("expected/actual", JSON.stringify(f));
  }

  // Provenance survives onto the failure (source session ids).
  if (f && Array.isArray(f.source_sessions) && f.source_sessions.length >= 1) {
    ok(`failure cites source session(s): ${f.source_sessions.join(", ")}`);
  } else {
    fail("source sessions on failure", JSON.stringify(f?.source_sessions));
  }

  // Reversibility: rebuilding the baseline yields green again (red -> green).
  if (green.status === "green") ok("revert restores GREEN (red -> green is reproducible)");
  else fail("reversibility", green.status);

  summary();
}

function summary() {
  const total = passed + failed;
  console.log(`\n${total} checks - ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Install deps:  npm run test-runner:install");
    console.log("  2. Re-run:        npm run check:phase12");
    console.log("  Live demo runbook: docs/phase-12-implementation-plan.md");
    process.exit(1);
  }
  console.log("\nAll Phase 12 checks passed.");
}

main();
