/**
 * Phase 15 round-trip harness (run via tsx by scripts/check-phase15.mjs).
 *
 * Proves the HITL store contract end to end against the REAL code on both sides:
 *   - the dashboard's write/read/merge logic (apps/platform-dashboard/server/hitl-store.ts)
 *   - the behavior-engine skip-gate reader (services/behavior-engine/src/coverage.ts)
 *
 * Both point at the same repo-root store (data/hitl/approvals.json), which is the
 * one place a human decision crosses back into the pipeline (ADR 0002). The check
 * script backs up and restores any pre-existing store around this run.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadFlows,
  readDecisions,
  upsertDecision,
} from "../apps/platform-dashboard/server/hitl-store.js";
import { buildCoverageManifest } from "../services/behavior-engine/src/coverage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STORE = resolve(REPO_ROOT, "data", "hitl", "approvals.json");

let passed = 0;
let failed = 0;
function ok(msg: string): void {
  passed += 1;
  console.log(`  ok  ${msg}`);
}
function fail(msg: string, detail?: string): void {
  failed += 1;
  console.log(`  XX  ${msg}${detail ? ` -> ${detail}` : ""}`);
}

// Two deterministic, valid 64-hex signatures (independent of gitignored candidates).
const SIG_A = "a".repeat(64);
const SIG_B = "b".repeat(64);

// Start clean.
if (existsSync(STORE)) rmSync(STORE);

// [1] Graceful absence: no store -> empty, never throws (PO-6 / BA-F8).
if (readDecisions().size === 0) ok("missing store -> readDecisions() empty");
else fail("missing store should read empty");
if (buildCoverageManifest().fromHitl === 0) ok("missing store -> coverage fromHitl == 0");
else fail("missing store should yield fromHitl 0");

// [2] Write two decisions (approve + discard) in the shape coverage.ts parses.
upsertDecision({ flow_signature: SIG_A, status: "approved", test_path: "generated-tests/x/aa.spec.ts" });
upsertDecision({ flow_signature: SIG_B, status: "discarded" });
const wrote = JSON.parse(readFileSync(STORE, "utf8"));
if (Array.isArray(wrote.entries) && wrote.entries.length === 2) {
  ok("store persisted as { entries: [...] } with 2 decisions");
} else {
  fail("store shape/count", JSON.stringify(wrote).slice(0, 120));
}

// [3] Re-decide A: update in place, no duplicate signature.
upsertDecision({ flow_signature: SIG_A, status: "discarded" });
const after = JSON.parse(readFileSync(STORE, "utf8"));
const aEntries = after.entries.filter((e: { flow_signature: string }) => e.flow_signature === SIG_A);
if (after.entries.length === 2 && aEntries.length === 1 && aEntries[0].status === "discarded") {
  ok("re-deciding updates entry in place (no duplicate, status flipped)");
} else {
  fail("re-decide dedup", JSON.stringify(after.entries).slice(0, 160));
}

// [4] Skip gate reads both approved + discarded signatures back.
const manifest = buildCoverageManifest();
if (
  manifest.fromHitl === 2 &&
  manifest.signatures.has(SIG_A) &&
  manifest.signatures.has(SIG_B)
) {
  ok("coverage.ts skip gate covers both approved + discarded signatures");
} else {
  fail("skip-gate integration", `fromHitl=${manifest.fromHitl}`);
}

// [5] Malformed store -> treated as empty, never fatal.
writeFileSync(STORE, "{ not json", "utf8");
try {
  const m = readDecisions();
  const cov = buildCoverageManifest();
  if (m.size === 0 && cov.fromHitl === 0) ok("malformed store -> empty, no throw");
  else fail("malformed store should be empty");
} catch (err) {
  fail("malformed store threw", err instanceof Error ? err.message : String(err));
}

// [6] loadFlows joins candidates + tests + decisions (or empty if candidates absent).
rmSync(STORE, { force: true });
const payload = loadFlows();
if (payload.flows.length === 0) {
  ok("loadFlows() returns empty payload with no candidates (clean-checkout safe)");
} else {
  const f = payload.flows[0];
  const shapeOk =
    typeof f.signature === "string" &&
    typeof f.persona === "string" &&
    Array.isArray(f.steps) &&
    Array.isArray(f.assertion_fields) &&
    "test_path" in f &&
    "decision" in f &&
    "covered" in f;
  if (shapeOk) ok(`loadFlows() joined ${payload.flows.length} flows (persona/steps/test/decision/covered)`);
  else fail("loadFlows shape", JSON.stringify(Object.keys(f)));

  // Decision write reflects into the next loadFlows() read.
  const target = payload.flows[0];
  upsertDecision({ flow_signature: target.signature, status: "approved", test_path: target.test_path });
  const reread = loadFlows().flows.find((x) => x.signature === target.signature);
  if (reread?.decision === "approved" && reread.covered) {
    ok("a written decision is reflected on the next loadFlows() read");
  } else {
    fail("decision not reflected", reread ? reread.decision ?? "null" : "missing");
  }
}

console.log(`\n${passed + failed} harness checks - ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
