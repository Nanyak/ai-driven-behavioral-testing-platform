/**
 * Phase 15 round-trip harness (run via tsx by scripts/check-phase15.mjs).
 *
 * Proves the HITL store contract end to end against the REAL code on both sides:
 *   - the dashboard's write/read/merge logic (apps/platform-dashboard/server/hitl-store.ts)
 *   - the behavior-engine skip-gate reader (services/behavior-engine/src/selection/coverage.ts)
 *
 * Both point at the same repo-root store (data/hitl/approvals.json), which is the
 * one place a human decision crosses back into the pipeline (ADR 0002). The check
 * script backs up and restores any pre-existing store around this run.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadFlows,
  readDecisionHistory,
  readDecisions,
  upsertDecision,
} from "../apps/platform-dashboard/server/hitl-store.js";
import { buildCoverageManifest } from "../services/behavior-engine/src/selection/coverage.js";
import { selectBusinessScenarios } from "../services/behavior-engine/src/selection/scenarios.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STORE = resolve(REPO_ROOT, "data", "hitl", "approvals.json");
const CANDIDATES = resolve(REPO_ROOT, "services", "behavior-engine", "data", "candidates");

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
const SIG_C = "c".repeat(64);
const SIG_D = "d".repeat(64);
const SIG_E = "e".repeat(64);

// Start clean.
if (existsSync(STORE)) rmSync(STORE);

// [1] Graceful absence: no store -> empty, never throws (PO-6 / BA-F8).
if (readDecisions().size === 0) ok("missing store -> readDecisions() empty");
else fail("missing store should read empty");
if (buildCoverageManifest().fromHitl === 0) ok("missing store -> coverage fromHitl == 0");
else fail("missing store should yield fromHitl 0");

// [2] Write two decisions (approve + discard) in the shape coverage.ts parses.
upsertDecision({
  flow_signature: SIG_A,
  status: "approved",
  test_path: "generated-tests/x/aa.spec.ts",
  spec_hash: "spec-hash-a",
  body_plan_hash: "body-plan-hash-a",
  body_rule_sources: ["openapi"],
});
upsertDecision({ flow_signature: SIG_B, status: "discarded" });
const wrote = JSON.parse(readFileSync(STORE, "utf8"));
if (Array.isArray(wrote.entries) && wrote.entries.length === 2) {
  ok("store persisted as { entries: [...] } with 2 decisions");
} else {
  fail("store shape/count", JSON.stringify(wrote).slice(0, 120));
}
const approvedA = readDecisions().get(SIG_A);
if (
  approvedA?.spec_hash === "spec-hash-a" &&
  approvedA.body_plan_hash === "body-plan-hash-a" &&
  approvedA.body_rule_sources?.[0] === "openapi"
) {
  ok("approved decision persists exact artifact hashes and provenance");
} else {
  fail("approved artifact binding was not persisted");
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

// [3b] A changed outcome is a new review version; approving it supersedes the
// previous baseline without erasing the audit record.
upsertDecision({
  flow_signature: SIG_C,
  status_signature: "200,200",
  status: "approved",
});
upsertDecision({
  flow_signature: SIG_C,
  status_signature: "200,500",
  status: "approved",
});
const cHistory = [...readDecisionHistory().values()].filter(
  (entry) => entry.flow_signature === SIG_C
);
if (
  cHistory.length === 2 &&
  cHistory.some((entry) => entry.status === "superseded") &&
  cHistory.some(
    (entry) => entry.status === "approved" && entry.status_signature === "200,500"
  )
) {
  ok("approving a changed outcome supersedes, rather than overwrites, its baseline");
} else {
  fail("outcome-versioned approval history", JSON.stringify(cHistory).slice(0, 240));
}

upsertDecision({
  flow_signature: SIG_D,
  flow_name: "first checkout route",
  persona: "registered_customer",
  route_key:
    "registered_customer|POST /store/carts/{id}/line-items > POST /store/carts/{id}/complete",
  status_signature: "200,200",
  status: "approved",
});
upsertDecision({
  flow_signature: SIG_E,
  flow_name: "replacement checkout route",
  persona: "registered_customer",
  route_key:
    "registered_customer|GET /store/products > POST /store/carts/{id}/line-items > POST /store/carts/{id}/complete",
  status_signature: "200,200,200",
  status: "approved",
});
const familyHistory = [...readDecisionHistory().values()].filter(
  (entry) => entry.flow_signature === SIG_D || entry.flow_signature === SIG_E
);
if (
  familyHistory.some((entry) => entry.flow_signature === SIG_D && entry.status === "approved") &&
  familyHistory.some((entry) => entry.flow_signature === SIG_E && entry.status === "approved") &&
  new Set(familyHistory.map((entry) => entry.scenario_key)).size === 1
) {
  ok("related scenario-family routes remain independently approved");
} else {
  fail("scenario-family isolation", JSON.stringify(familyHistory).slice(0, 300));
}

// [4] Skip gate reads both approved + discarded signatures back.
const manifest = buildCoverageManifest();
if (
  manifest.fromHitl === 5 &&
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

  const candidateFiles = existsSync(CANDIDATES)
    ? readdirSync(CANDIDATES)
        .filter((file) => file.startsWith("test-candidates-") && file.endsWith(".json"))
        .sort()
    : [];
  if (candidateFiles.length > 1) {
    const latest = JSON.parse(
      readFileSync(join(CANDIDATES, candidateFiles[candidateFiles.length - 1]), "utf8")
    ) as { candidates?: unknown[] };
    const expectedRepresentatives = selectBusinessScenarios(
      (latest.candidates ?? []) as Parameters<typeof selectBusinessScenarios>[0]
    ).representatives.length;
    if (
      payload.flows.length === expectedRepresentatives &&
      payload.flows
        .filter((flow) => flow.decision === null)
        .every((flow) => flow.seen_in_latest_run)
    ) {
      ok("API active queue matches shared latest-mine scenario selection");
    } else {
      fail(
        "active scenario reconciliation",
        `active=${payload.flows.length}, selected=${expectedRepresentatives}, latest=${latest.candidates?.length ?? 0}`
      );
    }
  }

  if (
    payload.counts.total === payload.flows.length &&
    payload.counts.awaiting_review ===
      payload.flows.filter((flow) => flow.lifecycle === "awaiting_review").length &&
    payload.flows.every((flow) => flow.variant_count >= 1)
  ) {
    ok("active counters and scenario variant metadata match visible representatives");
  } else {
    fail("active representative counters/variant metadata");
  }

  // Decision write reflects into the next loadFlows() read.
  const target = payload.flows[0];
  upsertDecision({
    review_id: target.review_id,
    flow_signature: target.signature,
    status_signature: target.status_signature,
    status: "approved",
    test_path: target.test_path,
  });
  const reread = loadFlows().flows.find((x) => x.signature === target.signature);
  if (reread?.decision === "approved" && reread.covered) {
    ok("a written decision is reflected on the next loadFlows() read");
  } else {
    fail("decision not reflected", reread ? reread.decision ?? "null" : "missing");
  }
}

console.log(`\n${passed + failed} harness checks - ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
