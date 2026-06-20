#!/usr/bin/env node

/**
 * Phase 10 verification: Test Execution
 *
 * Validates `services/test-runner` against the Phase 10 plan's acceptance
 * bullets (docs/phase-10-implementation-plan.md §"Validation / acceptance"):
 *   - tsc --noEmit is clean in services/test-runner (hard gate),
 *   - the GENERATED generated-tests/playwright.config.ts defines one project
 *     per persona folder (guest, customer, admin, edge) so persona-scoped runs
 *     work via `--project` (Phase 9 run.ts writes this; we read it back),
 *   - `playwright test --list --project <persona>` succeeds for every persona
 *     and lists only that folder's specs,
 *   - collect.ts correctly normalizes a KNOWN Playwright JSON report
 *     (committed fixture): persona/flow/source_sessions lifted from
 *     annotations, expected-vs-actual status parsed from the step error, golden
 *     diff lifted from the "golden-diff" attachment, trace_id omitted when
 *     absent, totals counted (passed/failed/skipped),
 *   - LIVE execution: if Medusa :9000/health is reachable, run `test:edge` and
 *     assert a JSON report + normalized result are written under
 *     reports/playwright/. If Medusa is UNREACHABLE, this gate is SKIPPED with
 *     a clear message (the wiring/projects/collect gates still run) — a down
 *     backend must not hard-fail the whole phase check.
 *
 * Installs services/test-runner + generated-tests node_modules if missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICE = resolve(ROOT, "services", "test-runner");
const GENERATED_TESTS_DIR = resolve(ROOT, "generated-tests");
const CONFIG_PATH = resolve(GENERATED_TESTS_DIR, "playwright.config.ts");
const FIXTURE = resolve(SERVICE, "fixtures", "sample-playwright-report.json");
const REPORTS_DIR = resolve(ROOT, "reports", "playwright");
const PERSONA_PROJECTS = ["guest", "customer", "admin", "edge"];

/** Read the canonical repo-root .env (mirrors traffic-generator config.ts) for the backend URL. */
function loadEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}
const MEDUSA_HEALTH = (process.env.MEDUSA_BACKEND_URL ?? loadEnv().MEDUSA_BACKEND_URL ?? "http://localhost:9000") + "/health";

let passed = 0;
let failed = 0;
let skipped = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);
const skip = (m) => (console.log(`  ⊘ ${m} (skipped)`), skipped++);

async function medusaReachable() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(MEDUSA_HEALTH, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log("Phase 10: Test Execution Check");

  // [1] test-runner tsc --noEmit clean (hard gate).
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

  // [2] Generated playwright.config.ts defines one project per persona folder.
  console.log("\n[2] generated-tests/playwright.config.ts defines 4 persona projects");
  if (!existsSync(CONFIG_PATH)) {
    fail("playwright.config.ts present", `expected ${CONFIG_PATH} — run npm run script-generator:generate`);
  } else {
    const config = readFileSync(CONFIG_PATH, "utf8");
    const missing = PERSONA_PROJECTS.filter((p) => !new RegExp(`name:\\s*["']${p}["']`).test(config));
    if (missing.length === 0) ok(`config defines projects: ${PERSONA_PROJECTS.join(", ")}`);
    else fail("persona projects in config", `missing: ${missing.join(", ")}`);
  }

  // [3] playwright test --list --project <persona> works per persona.
  console.log("\n[3] playwright test --list --project <persona> per persona");
  if (!existsSync(resolve(GENERATED_TESTS_DIR, "node_modules"))) {
    const install = spawnSync("npm", ["install"], { cwd: GENERATED_TESTS_DIR, encoding: "utf8" });
    if (install.status !== 0) {
      fail("generated-tests/ npm install", (install.stdout || install.stderr || "").trim().split("\n").slice(-3).join(" | "));
      return summary();
    }
  }
  for (const project of PERSONA_PROJECTS) {
    const list = spawnSync("npx", ["playwright", "test", "--list", "--project", project], {
      cwd: GENERATED_TESTS_DIR,
      encoding: "utf8",
    });
    const out = list.stdout || list.stderr || "";
    const total = out.match(/Total:\s*(\d+)\s*tests?/i);
    if (list.status === 0 && total) ok(`--project ${project} lists ${total[1]} test(s)`);
    else fail(`--project ${project} list`, out.trim().split("\n").slice(-3).join(" | "));
  }

  // [4] collect.ts normalizes a known Playwright JSON fixture correctly.
  console.log("\n[4] collect.ts normalizes a known Playwright JSON fixture");
  if (!existsSync(FIXTURE)) {
    fail("sample fixture present", `expected ${FIXTURE}`);
  } else {
    const probe = `
      import { collectFromFile } from ${JSON.stringify(resolve(SERVICE, "src", "collect.js"))};
      const r = collectFromFile(${JSON.stringify(FIXTURE)});
      process.stdout.write(JSON.stringify(r));
    `;
    const probePath = resolve(SERVICE, ".collect-probe.mts");
    writeFileSync(probePath, probe);
    const run = spawnSync("npx", ["tsx", probePath], { cwd: SERVICE, encoding: "utf8" });
    rmSync(probePath, { force: true });
    if (run.status !== 0) {
      fail("collect.ts probe", (run.stdout || run.stderr || "").trim().split("\n").slice(-3).join(" | "));
    } else {
      let r;
      try {
        r = JSON.parse(run.stdout);
      } catch {
        fail("collect.ts output parse", run.stdout.slice(0, 200));
        r = null;
      }
      if (r) {
        const t = r.totals;
        if (t && t.executed === 3 && t.passed === 1 && t.failed === 1 && t.skipped === 1) {
          ok(`totals normalized (executed 3, passed 1, failed 1, skipped 1)`);
        } else {
          fail("totals", JSON.stringify(t));
        }
        const failedTest = r.tests.find((x) => x.status === "failed");
        const failStep = failedTest?.steps?.find((s) => s.status === "failed");
        if (failStep && failStep.expected_status === 200 && failStep.actual_status === 500) {
          ok("expected-vs-actual status parsed from step error (200 vs 500)");
        } else {
          fail("expected/actual status", JSON.stringify(failStep));
        }
        if (failStep && Array.isArray(failStep.golden_diff) && failStep.golden_diff.length === 1) {
          ok("golden diff lifted from golden-diff attachment");
        } else {
          fail("golden diff lift", JSON.stringify(failStep?.golden_diff));
        }
        if (failedTest && Array.isArray(failedTest.source_sessions) && failedTest.source_sessions.length === 2) {
          ok("source_sessions lifted from annotation (2)");
        } else {
          fail("source_sessions lift", JSON.stringify(failedTest?.source_sessions));
        }
        const anyTraceId = r.tests.some((x) => "trace_id" in x);
        if (!anyTraceId) ok("trace_id omitted when absent (never invented)");
        else fail("trace_id", "trace_id present despite no annotation");
      }
    }
  }

  // [5] LIVE execution (graceful skip when Medusa is down).
  console.log("\n[5] Live execution (test:edge) — requires Medusa :9000");
  if (!(await medusaReachable())) {
    skip(`Medusa not reachable at ${MEDUSA_HEALTH}; wiring/projects/collect validated above`);
  } else {
    const run = spawnSync("npm", ["run", "test:edge"], { cwd: ROOT, encoding: "utf8" });
    // Playwright may exit non-zero if a test fails; we only require the run to
    // have produced a normalized report, not that every test passes.
    const normalized = resolve(REPORTS_DIR, "normalized.json");
    const jsonReport = resolve(REPORTS_DIR, "results.json");
    if (existsSync(jsonReport) && existsSync(normalized)) {
      const norm = JSON.parse(readFileSync(normalized, "utf8"));
      ok(`live test:edge ran; normalized ${norm.totals.executed} test(s) -> reports/playwright/`);
    } else {
      fail("live test:edge report", (run.stdout || run.stderr || "").trim().split("\n").slice(-4).join(" | "));
    }
  }

  summary();
}

function summary() {
  const total = passed + failed + skipped;
  console.log(`\n${total} checks - ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Install deps:    npm run test-runner:install");
    console.log("  2. Regenerate specs (for projects/config): npm run script-generator:generate");
    console.log("  3. Re-run:          npm run check:phase10");
    process.exit(1);
  }
  console.log("\nAll Phase 10 checks passed.");
}

main();
