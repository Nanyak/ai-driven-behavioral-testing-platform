/**
 * Unit test for the OUTCOME-AWARE skip gate (coverage.ts). Run: `npm run test:coverage`.
 *
 * Plain assertions, no framework — mirrors signature.test.ts. Exits non-zero on the
 * first failure so the check script can gate on it.
 *
 * Properties under test:
 *   - a drift of an approved journey (same signature, different outcome) survives the
 *     gate instead of being silently skipped (the signature excludes status);
 *   - a blessed outcome is skipped ONLY when a spec already asserts it — a blessed
 *     outcome with no oracle yet is KEPT so the generator can emit it (this closes
 *     the approve-then-remine-before-regenerate ordering gap).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySkipGate, buildCoverageManifest, type CoverageManifest } from "./coverage.js";
import type { CandidateStep, MinedFlow } from "./dedup.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const step = (method: string, endpoint: string, expected_status: number): CandidateStep => ({
  method,
  endpoint,
  expected_status,
});

/** Build a MinedFlow with a fixed signature and the given step outcomes. */
function flow(signature: string, steps: CandidateStep[]): MinedFlow {
  return {
    signature,
    tokens: steps.map((s) => `${s.method} ${s.endpoint}`),
    steps,
    support: 5,
    persona: "registered_customer",
    attributes: { requires_auth: true, is_admin: false, has_errors: steps.some((s) => s.expected_status >= 400) },
    source_sessions: [],
  };
}

const SIG = "a".repeat(64);
const checkoutSteps = (completeStatus: number): CandidateStep[] => [
  step("GET", "/store/products", 200),
  step("POST", "/store/carts", 200),
  step("POST", "/store/carts/{id}/complete", completeStatus),
];

// A baseline approved GREEN (…complete → 200) whose oracle spec already asserts 200.
const manifest = (): CoverageManifest => ({
  signatures: new Set([SIG]),
  approvedOutcomes: new Map([[SIG, new Set(["200,200,200"])]]),
  specOutcomes: new Map([[SIG, new Set(["200,200,200"])]]),
  fromTests: 1,
  fromHitl: 1,
});

// 1. A new shape (not covered) always survives the gate.
check("new shape is kept", () => {
  const { kept, skipped } = applySkipGate([flow("b".repeat(64), checkoutSteps(200))], manifest());
  assert.equal(kept.length, 1);
  assert.equal(skipped.length, 0);
});

// 2. Blessed outcome whose oracle already exists is skipped (stable).
check("blessed outcome with an existing oracle is skipped", () => {
  const { kept, skipped } = applySkipGate([flow(SIG, checkoutSteps(200))], manifest());
  assert.equal(skipped.length, 1);
  assert.equal(kept.length, 0);
});

// 3. Same journey, blessed outcome differs (200 -> 500) — the regression survives.
check("drifted outcome is kept (regression surfaces)", () => {
  const { kept, skipped } = applySkipGate([flow(SIG, checkoutSteps(500))], manifest());
  assert.equal(kept.length, 1, "regression must be kept");
  assert.equal(skipped.length, 0);
});

// 4. THE ORDERING FIX: an outcome that is now BLESSED but whose oracle has not been
//    generated yet (no spec asserts it) is KEPT — even after a re-mine — so the
//    generator can still emit the new oracle. Here 500 was just approved but the
//    only spec on disk still asserts the old 200.
check("blessed outcome with no oracle yet is kept (ordering gap closed)", () => {
  const m: CoverageManifest = {
    signatures: new Set([SIG]),
    approvedOutcomes: new Map([[SIG, new Set(["200,200,500"])]]),
    specOutcomes: new Map([[SIG, new Set(["200,200,200"])]]), // stale oracle only
    fromTests: 1,
    fromHitl: 1,
  };
  const { kept, skipped } = applySkipGate([flow(SIG, checkoutSteps(500))], m);
  assert.equal(kept.length, 1, "blessed-but-unspecced outcome must be kept");
  assert.equal(skipped.length, 0);
});

// 5. No approved baseline -> shape-level coverage (unchanged): a shape with a spec
//    is skipped regardless of outcome.
check("covered shape with no approved baseline is skipped (shape-level)", () => {
  const m: CoverageManifest = {
    signatures: new Set([SIG]),
    approvedOutcomes: new Map(),
    specOutcomes: new Map(),
    fromTests: 1,
    fromHitl: 0,
  };
  const { kept, skipped } = applySkipGate([flow(SIG, checkoutSteps(500))], m);
  assert.equal(skipped.length, 1);
  assert.equal(kept.length, 0);
});

// 6. Integration: buildCoverageManifest reads the blessed outcome from a real HITL
//    store AND the oracle outcome from a real stamped spec; the gate then skips the
//    stable flow but surfaces a drift. Proves the full FS wiring, not just the algebra.
check("buildCoverageManifest wires approved + spec outcomes from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-"));
  const hitlStore = join(dir, "approvals.json");
  writeFileSync(
    hitlStore,
    JSON.stringify({
      entries: [{ flow_signature: SIG, status: "approved", status_signature: "200,200,200" }],
    })
  );
  const testsDir = join(dir, "generated-tests", "customer", "happy-path");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    join(testsDir, "spec.spec.ts"),
    `// flow_signature: ${SIG}\n// status_signature: 200,200,200\ntest("x", async () => {});\n`
  );
  const m = buildCoverageManifest({ generatedTestsDir: join(dir, "generated-tests"), hitlStore });
  assert.deepEqual([...(m.approvedOutcomes.get(SIG) ?? [])], ["200,200,200"]);
  assert.deepEqual([...(m.specOutcomes.get(SIG) ?? [])], ["200,200,200"]);

  assert.equal(applySkipGate([flow(SIG, checkoutSteps(200))], m).skipped.length, 1, "stable -> skip");
  assert.equal(applySkipGate([flow(SIG, checkoutSteps(500))], m).kept.length, 1, "drift -> keep");
});

console.log(`\ncoverage.test: ${passed} checks passed`);
