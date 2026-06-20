#!/usr/bin/env node

/**
 * Phase 11 verification: Reporting
 *
 * Validates `services/test-runner/src/report/*` against the Phase 11 plan's
 * acceptance bullets (docs/phase-11-implementation-plan.md §"Validation"):
 *   - tsc --noEmit is clean in services/test-runner (hard gate),
 *   - buildReport() aggregates a KNOWN normalized run (the committed Playwright
 *     fixture, via collect.ts) into totals + per-persona + per-flow + endpoint
 *     failures + a failures list that cites persona/flow/endpoint/expected-vs-
 *     actual/golden diff/source sessions,
 *   - writeReports() emits reports/report.json AND a self-contained
 *     reports/report.html that opens locally and renders the summary + tables.
 *
 * Fully offline — no live stack, no goldens needed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICE = resolve(ROOT, "services", "test-runner");
const FIXTURE = resolve(SERVICE, "fixtures", "sample-playwright-report.json");

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

function main() {
  console.log("Phase 11: Reporting Check");

  // [1] tsc clean (hard gate).
  console.log("\n[1] TypeScript compile (services/test-runner tsc --noEmit)");
  if (!existsSync(resolve(SERVICE, "node_modules"))) {
    const install = spawnSync("npm", ["install"], { cwd: SERVICE, encoding: "utf8" });
    if (install.status !== 0) {
      fail("services/test-runner npm install", (install.stdout || install.stderr || "").trim().split("\n").slice(-3).join(" | "));
      return summary();
    }
  }
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: SERVICE, encoding: "utf8" });
  if (tsc.status === 0) ok("tsc --noEmit is clean");
  else fail("tsc --noEmit", (tsc.stdout || tsc.stderr || "").trim().split("\n").slice(0, 5).join(" | "));

  // [2] Build a report from the known fixture and write both files to a temp dir.
  console.log("\n[2] buildReport + writeReports over the known normalized fixture");
  const outDir = mkdtempSync(resolve(tmpdir(), "phase11-"));
  const probe = `
    import { collectFromFile } from ${JSON.stringify(resolve(SERVICE, "src", "collect.js"))};
    import { buildReport } from ${JSON.stringify(resolve(SERVICE, "src", "report", "build.js"))};
    import { writeReports } from ${JSON.stringify(resolve(SERVICE, "src", "report", "write.js"))};
    const norm = collectFromFile(${JSON.stringify(FIXTURE)});
    const { report, jsonPath, htmlPath } = writeReports(norm, ${JSON.stringify(outDir)}, { runId: "run-test-0001" });
    process.stdout.write(JSON.stringify({ report, jsonPath, htmlPath }));
  `;
  const probePath = resolve(SERVICE, ".report-probe.mts");
  writeFileSync(probePath, probe);
  const run = spawnSync("npx", ["tsx", probePath], { cwd: SERVICE, encoding: "utf8" });
  rmSync(probePath, { force: true });

  if (run.status !== 0) {
    fail("report probe", (run.stdout || run.stderr || "").trim().split("\n").slice(-3).join(" | "));
    rmSync(outDir, { recursive: true, force: true });
    return summary();
  }

  let out;
  try {
    out = JSON.parse(run.stdout);
  } catch {
    fail("report probe output parse", run.stdout.slice(0, 200));
    rmSync(outDir, { recursive: true, force: true });
    return summary();
  }
  const r = out.report;

  // totals carried through from the normalized run.
  if (r.totals.executed === 3 && r.totals.passed === 1 && r.totals.failed === 1 && r.totals.skipped === 1) {
    ok("totals aggregated (executed 3, passed 1, failed 1, skipped 1)");
  } else {
    fail("totals", JSON.stringify(r.totals));
  }

  // red verdict because one test failed.
  if (r.status === "red") ok("verdict is red (one test failed)");
  else fail("verdict", r.status);

  // per-persona rollup.
  const cust = r.by_persona.find((p) => p.persona === "registered_customer");
  const guest = r.by_persona.find((p) => p.persona === "guest_shopper");
  if (cust && cust.failed === 1 && guest && guest.passed === 1) {
    ok("by_persona rollup attributes failure to registered_customer, pass to guest");
  } else {
    fail("by_persona", JSON.stringify(r.by_persona));
  }

  // per-flow rollup present.
  if (Array.isArray(r.by_flow) && r.by_flow.some((f) => f.failed === 1)) {
    ok("by_flow rollup includes the failing flow");
  } else {
    fail("by_flow", JSON.stringify(r.by_flow));
  }

  // endpoint failures: the line-items step carried the 200->500 error.
  const top = r.endpoint_failures[0];
  if (top && top.endpoint === "POST /store/carts/{id}/line-items" && top.failures === 1) {
    ok(`endpoint_failures top = ${top.endpoint} (${top.failures})`);
  } else {
    fail("endpoint_failures", JSON.stringify(r.endpoint_failures));
  }

  // failure entry cites every required field (plan §Required fields).
  const f = r.failures[0];
  const hasProvenance = f && Array.isArray(f.source_sessions) && f.source_sessions.length === 2;
  const hasStatus = f && f.expected_status === 200 && f.actual_status === 500;
  const hasGolden = f && f.golden_diff && Array.isArray(f.golden_diff.unexpected) && f.golden_diff.unexpected.includes("error");
  if (f && f.persona === "registered_customer" && f.flow_name && f.endpoint && hasStatus && hasGolden && hasProvenance) {
    ok("failure cites persona, flow, endpoint, 200->500, golden diff, source sessions");
  } else {
    fail("failure entry fields", JSON.stringify(f));
  }

  // trace_id omitted when absent upstream (never invented).
  if (f && !("trace_id" in f)) ok("trace_id omitted when absent (never invented)");
  else fail("trace_id", "present despite no upstream trace id");

  // [3] report.json + report.html written and self-contained.
  console.log("\n[3] reports written (report.json + self-contained report.html)");
  if (existsSync(out.jsonPath) && existsSync(out.htmlPath)) {
    ok("report.json and report.html both written");
  } else {
    fail("report files", `json=${existsSync(out.jsonPath)} html=${existsSync(out.htmlPath)}`);
  }
  const html = existsSync(out.htmlPath) ? readFileSync(out.htmlPath, "utf8") : "";
  const selfContained = html.includes("<style>") && !/<link|<script/i.test(html);
  if (selfContained && html.includes("Regression Report") && html.includes("POST /store/carts/{id}/line-items")) {
    ok("report.html is self-contained and renders the summary + failing endpoint");
  } else {
    fail("report.html content", `selfContained=${selfContained}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  summary();
}

function summary() {
  const total = passed + failed;
  console.log(`\n${total} checks - ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Install deps:  npm run test-runner:install");
    console.log("  2. Re-run:        npm run check:phase11");
    process.exit(1);
  }
  console.log("\nAll Phase 11 checks passed.");
}

main();
