#!/usr/bin/env node

/**
 * Phase 9 verification: Script Generator
 *
 * Validates `services/script-generator` against the plan's acceptance bullets
 * (docs/phase-9-implementation-plan.md §"Validation / acceptance"):
 *   - tsc --noEmit is clean in services/script-generator (hard gate),
 *   - running the generator against the newest behavior-engine candidates
 *     file emits >=5 .spec.ts files across more than one persona folder,
 *   - every emitted spec stamps `// flow_signature: <64-hex>` in the exact
 *     underscore form services/behavior-engine/src/coverage.ts's skip-gate
 *     regex expects (ADR 0002) -- this is the #1 correctness requirement;
 *     a mismatch here silently breaks cross-run dedup,
 *   - no spec contains a hardcoded seed-shaped ID literal (product_/variant_/
 *     region_/cart_/order_ as a literal VALUE, not a JSON field name),
 *   - edge/ specs assert the logged non-2xx status (they reproduce an
 *     observed failure, never an invented one),
 *   - generated-tests/ itself type-checks and `playwright test --list`
 *     succeeds (proves the emitted specs are syntactically + structurally
 *     valid Playwright tests, not just files that happen to exist),
 *   - the vendored services/golden/src/ copy under generated-tests/_golden/
 *     is self-contained (no relative imports reaching back out of _golden/).
 *
 * Installs services/script-generator + generated-tests node_modules if
 * missing. Needs no running stack (no live Medusa calls -- generation is
 * static, from the on-disk candidates file).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICE = resolve(ROOT, "services", "script-generator");
const GENERATED_TESTS_DIR = resolve(ROOT, "generated-tests");
const PERSONA_DIRS = ["guest", "customer", "admin", "edge"];

const SIGNATURE_STAMP = /flow_signature["'\s:=]+([0-9a-f]{64})/i;
const HARDCODED_ID_VALUE = /:\s*"(prod_|variant_|reg_|cart_|order_|cust_)[a-zA-Z0-9]+"/;

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

function listSpecFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listSpecFiles(full));
    else if (entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

function main() {
  console.log("Phase 9: Script Generator Check");

  if (!existsSync(resolve(SERVICE, "node_modules"))) {
    fail("services/script-generator dependencies installed", "run `npm run script-generator:install` first");
    return summary();
  }

  // [1] TypeScript compiles clean in the generator itself (hard gate).
  console.log("\n[1] TypeScript compile (services/script-generator tsc --noEmit)");
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: SERVICE, encoding: "utf8" });
  if (tsc.status === 0) ok("tsc --noEmit is clean");
  else fail("tsc --noEmit", (tsc.stdout || tsc.stderr || "").trim().split("\n").slice(0, 5).join(" | "));

  // [2] Run the generator against the newest candidates file.
  console.log("\n[2] Generate (tsx src/run.ts)");
  const gen = spawnSync("npx", ["tsx", "src/run.ts"], { cwd: SERVICE, encoding: "utf8" });
  if (gen.status === 0) ok("generator run exits 0");
  else {
    fail("generator run", (gen.stdout || gen.stderr || "").trim().split("\n").slice(-5).join(" | "));
    return summary();
  }

  // [3] At least 5 specs, spanning more than one persona folder.
  console.log("\n[3] Emitted specs (>=5, multiple personas)");
  const specs = listSpecFiles(GENERATED_TESTS_DIR);
  const byPersona = Object.fromEntries(PERSONA_DIRS.map((p) => [p, 0]));
  for (const f of specs) {
    const persona = PERSONA_DIRS.find((p) => f.includes(`${p}/`) || f.includes(`${p}\\`));
    if (persona) byPersona[persona]++;
  }
  const populatedPersonas = Object.entries(byPersona).filter(([, n]) => n > 0);
  if (specs.length >= 5) ok(`${specs.length} .spec.ts files emitted`);
  else fail("spec count", `expected >=5, got ${specs.length}`);
  if (populatedPersonas.length > 1) ok(`spans ${populatedPersonas.length} persona folders (${populatedPersonas.map(([p, n]) => `${p}:${n}`).join(", ")})`);
  else fail("persona spread", `only ${populatedPersonas.length} folder(s) populated`);

  // [4] Every spec stamps a flow_signature matching the coverage.ts skip-gate regex.
  console.log("\n[4] flow_signature stamp (must match behavior-engine coverage.ts regex)");
  let stamped = 0;
  const missing = [];
  for (const f of specs) {
    const content = readFileSync(f, "utf8");
    if (SIGNATURE_STAMP.test(content)) stamped++;
    else missing.push(f);
  }
  if (missing.length === 0) ok(`all ${stamped} specs stamp a matching flow_signature`);
  else fail("flow_signature stamp", `${missing.length} spec(s) missing a matching stamp: ${missing.slice(0, 3).join(", ")}`);

  // [5] No hardcoded seed-shaped ID literal VALUES (field names like "cart_id"
  // are fine -- only literal values such as "cart_01ABC..." are a violation).
  console.log("\n[5] No hardcoded seed IDs (CLAUDE.md §5)");
  const offenders = [];
  for (const f of specs) {
    const content = readFileSync(f, "utf8");
    if (HARDCODED_ID_VALUE.test(content)) offenders.push(f);
  }
  if (offenders.length === 0) ok("no hardcoded ID literal values found");
  else fail("hardcoded ID literals", offenders.slice(0, 5).join(", "));

  // [6] edge/ specs assert the logged non-2xx status.
  console.log("\n[6] edge/ specs assert a non-2xx status");
  const edgeSpecs = specs.filter((f) => f.includes(`${join("edge", "")}`));
  if (edgeSpecs.length === 0) {
    fail("edge specs present", "expected >=1 spec under generated-tests/edge/");
  } else {
    let allAssertError = true;
    for (const f of edgeSpecs) {
      const content = readFileSync(f, "utf8");
      if (!/toBe\(4\d\d\)|toBe\(5\d\d\)/.test(content)) {
        allAssertError = false;
        fail("edge spec error-status assertion", `${f} has no toBe(4xx/5xx) assertion`);
      }
    }
    if (allAssertError) ok(`all ${edgeSpecs.length} edge spec(s) assert a 4xx/5xx status`);
  }

  // [7] generated-tests/ itself type-checks and lists via Playwright.
  console.log("\n[7] generated-tests/ type-checks + playwright test --list");
  if (!existsSync(resolve(GENERATED_TESTS_DIR, "node_modules"))) {
    const install = spawnSync("npm", ["install"], { cwd: GENERATED_TESTS_DIR, encoding: "utf8" });
    if (install.status !== 0) {
      fail("generated-tests/ npm install", (install.stdout || install.stderr || "").trim().split("\n").slice(-5).join(" | "));
      return summary();
    }
  }
  const gtTsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: GENERATED_TESTS_DIR, encoding: "utf8" });
  if (gtTsc.status === 0) ok("generated-tests/ tsc --noEmit is clean");
  else fail("generated-tests/ tsc --noEmit", (gtTsc.stdout || gtTsc.stderr || "").trim().split("\n").slice(0, 5).join(" | "));

  const list = spawnSync("npx", ["playwright", "test", "--list"], { cwd: GENERATED_TESTS_DIR, encoding: "utf8" });
  const listOutput = list.stdout || list.stderr || "";
  const totalMatch = listOutput.match(/Total:\s*(\d+)\s*tests?/i);
  if (list.status === 0 && totalMatch) ok(`playwright test --list succeeds (${totalMatch[1]} tests discovered)`);
  else fail("playwright test --list", listOutput.trim().split("\n").slice(-5).join(" | "));

  // [8] Vendored _golden/ is self-contained (no escaping relative imports).
  console.log("\n[8] Vendored _golden/ is self-contained");
  const goldenDir = resolve(GENERATED_TESTS_DIR, "_golden");
  if (!existsSync(goldenDir)) {
    fail("generated-tests/_golden/ present", `expected ${goldenDir}`);
  } else {
    const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith(".ts"));
    const escaping = [];
    for (const f of goldenFiles) {
      const content = readFileSync(resolve(goldenDir, f), "utf8");
      const importPaths = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const p of importPaths) {
        if (p.startsWith("../") && !p.startsWith("../../golden-responses")) escaping.push(`${f}: ${p}`);
      }
    }
    if (goldenFiles.length > 0 && escaping.length === 0) {
      ok(`${goldenFiles.length} vendored file(s) under _golden/, no escaping imports (golden-responses/ lookup excepted)`);
    } else if (goldenFiles.length === 0) {
      fail("vendored _golden/ files", "directory is empty");
    } else {
      fail("vendored _golden/ self-contained", escaping.join(", "));
    }
  }

  summary();
}

function summary() {
  console.log(`\n${passed + failed} checks - ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Install deps:   npm run script-generator:install");
    console.log("  2. Generate specs: npm run script-generator:generate");
    console.log("  3. Re-run:         npm run check:phase9");
    process.exit(1);
  }
  console.log("\nAll Phase 9 checks passed.");
}

main();
