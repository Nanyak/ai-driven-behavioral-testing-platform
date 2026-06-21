#!/usr/bin/env node

/**
 * Phase 15 verification: HITL Review Dashboard (offline).
 *
 * Two parts:
 *   [1] Structure — the review surface exists and the endpoint is wired:
 *       server/hitl-store.ts + vite-plugin-hitl.ts, src/review/* , and
 *       vite.config.ts registers hitlApiPlugin().
 *   [2] Contract — a tsx harness drives the REAL store logic
 *       (apps/platform-dashboard/server/hitl-store.ts) and the REAL skip-gate
 *       reader (services/behavior-engine/src/coverage.ts) against the shared
 *       repo-root store, proving: graceful absence, persisted shape, in-place
 *       re-decide (no duplicate), approved+discarded both feed the skip gate,
 *       malformed-store tolerance, and loadFlows() join.
 *
 * Any pre-existing data/hitl/approvals.json is backed up and restored.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let passed = 0;
let failed = 0;
const ok = (m) => { passed += 1; console.log(`  ok  ${m}`); };
const fail = (m, d) => { failed += 1; console.log(`  XX  ${m}${d ? ` -> ${d}` : ""}`); };

// [1] Structure.
console.log("[1] Review surface + endpoint wiring");
const files = [
  "apps/platform-dashboard/server/hitl-store.ts",
  "apps/platform-dashboard/server/vite-plugin-hitl.ts",
  "apps/platform-dashboard/src/review/ReviewView.tsx",
  "apps/platform-dashboard/src/review/useFlows.ts",
  "apps/platform-dashboard/src/review/decisions.ts",
];
for (const f of files) {
  if (existsSync(resolve(ROOT, f))) ok(f);
  else fail("missing file", f);
}

const viteConfig = resolve(ROOT, "apps/platform-dashboard/vite.config.ts");
if (existsSync(viteConfig)) {
  const src = readFileSync(viteConfig, "utf8");
  if (src.includes("hitlApiPlugin")) ok("vite.config.ts registers hitlApiPlugin()");
  else fail("vite.config.ts does not wire hitlApiPlugin()");
} else {
  fail("vite.config.ts missing");
}

// [2] Contract round-trip (real code, via tsx).
console.log("\n[2] HITL store + skip-gate contract (tsx round-trip)");
const STORE = resolve(ROOT, "data", "hitl", "approvals.json");
const BACKUP = `${STORE}.checkbak`;
if (existsSync(STORE)) renameSync(STORE, BACKUP);

const tsx = resolve(ROOT, "services", "behavior-engine", "node_modules", ".bin", "tsx");
if (!existsSync(tsx)) {
  fail("tsx not found", "run `npm run behavior:install`");
} else {
  const r = spawnSync(tsx, [resolve(__dirname, "phase15-harness.mts")], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write((r.stdout || "").replace(/^/gm, "  "));
  if (r.status === 0) ok("round-trip harness passed");
  else fail("round-trip harness failed", (r.stderr || "").trim().split("\n").slice(-3).join(" | "));
}

// Restore any pre-existing store.
rmSync(STORE, { force: true });
if (existsSync(BACKUP)) renameSync(BACKUP, STORE);

// Summary.
const total = passed + failed;
console.log(`\n${total} checks - ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nTroubleshooting:");
  console.log("  1. Install deps:  npm install --prefix apps/platform-dashboard && npm run behavior:install");
  console.log("  2. Review UI:     npm run dashboard:dev  (Flow Review tab, http://localhost:5173)");
  process.exit(1);
}
console.log("\nAll Phase 15 checks passed.");
console.log("Review UI: npm run dashboard:dev -> Flow Review tab (http://localhost:5173).");
