/**
 * Skill-library unit tests (run: `tsx src/skill/skill.test.ts`).
 * Pure functions only — no agent, no backend. Covers the trust-critical seams:
 * key derivation reproduces the old switch, the oracle evaluator agrees with the
 * invariants layer, and the verify bake gate flips a skill to verified ONLY when
 * its oracle holds against a captured body.
 */
import assert from "node:assert/strict";
import {
  SKILLS,
  buildSkillsArtifact,
  evaluateSkillOracle,
  resolveSkillForVar,
  skillId,
  skillKeyForVar,
  verifySkills,
} from "./registry.js";
import { bodiesByOracleEndpoint } from "./cli.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// --- key derivation reproduces the old standaloneResolverFor overloading ------
check("orderId splits into three explicit states by (fulfilledOrder, cancelFlow)", () => {
  assert.deepEqual(skillKeyForVar("orderId", "admin-token", true, false), {
    entity: "order",
    state: "fulfilled",
  });
  assert.deepEqual(skillKeyForVar("orderId", "admin-token", false, true), {
    entity: "order",
    state: "cancelable",
  });
  assert.deepEqual(skillKeyForVar("orderId", "admin-token", false, false), {
    entity: "order",
    state: "cancelable-newest",
  });
});

check("productId is auth-scoped (admin list vs store list)", () => {
  const admin = resolveSkillForVar("productId", "admin-token");
  const store = resolveSkillForVar("productId", "publishable-key");
  assert.ok(admin && admin[0].endpoint.startsWith("/admin/products"));
  assert.ok(store && store[0].endpoint.startsWith("/store/products"));
});

check("an unknown var resolves to no skill (returns null)", () => {
  assert.equal(resolveSkillForVar("nonsenseVar", "publishable-key"), null);
});

// --- every registered skill is well-formed ------------------------------------
check("every skill carries an oracle whose endpoint names a step it runs", () => {
  for (const s of SKILLS) {
    assert.ok(s.oracle.endpoint.length > 0, `${skillId(s.key, s.auth)} has empty oracle endpoint`);
    assert.ok(s.oracle.path.length > 0, `${skillId(s.key, s.auth)} has empty oracle path`);
    assert.ok(s.steps.length > 0, `${skillId(s.key, s.auth)} has no steps`);
  }
});

// --- oracle evaluator agrees with the invariants layer ------------------------
check("evaluateSkillOracle holds on a matching body, fails on a mismatch", () => {
  const oracle = { endpoint: "/store/regions", path: "regions[0].id", matcher: "toBeDefined", rationale: "x" } as const;
  assert.equal(evaluateSkillOracle(oracle, { regions: [{ id: "reg_1" }] }), true);
  assert.equal(evaluateSkillOracle(oracle, { regions: [] }), false);
});

// --- the verify bake gate -----------------------------------------------------
check("verifySkills flips verified:true ONLY when the oracle holds", () => {
  const region = SKILLS.find((s) => s.key.entity === "region");
  assert.ok(region, "expected a region skill in the registry");
  const id = skillId(region!.key, region!.auth);

  // Present + holding body -> verified.
  const good = new Map<string, unknown>([[region!.oracle.endpoint, { regions: [{ id: "reg_1" }] }]]);
  assert.equal(verifySkills(good).skills[id].verified, true);

  // Present but empty body -> oracle fails -> stays unverified.
  const empty = new Map<string, unknown>([[region!.oracle.endpoint, { regions: [] }]]);
  assert.equal(verifySkills(empty).skills[id].verified, false);

  // Absent body -> stays unverified (no false positive).
  assert.equal(verifySkills(new Map()).skills[id].verified, false);
});

check("buildSkillsArtifact lists every skill as verified:false (the propose side)", () => {
  const art = buildSkillsArtifact();
  assert.equal(Object.keys(art.skills).length, SKILLS.length);
  assert.ok(Object.values(art.skills).every((s) => s.verified === false));
});

// --- CLI matcher: captured run bodies map onto oracle endpoints ----------------
check("bodiesByOracleEndpoint matches exact endpoints and query-stripped paths", () => {
  const region = SKILLS.find((s) => s.key.entity === "region")!;
  // A skill whose oracle endpoint carries a query string still matches a captured
  // body recorded under the bare path.
  const queried = SKILLS.find((s) => s.oracle.endpoint.includes("?"));
  const run = new Map<string, unknown>([[region.oracle.endpoint, { regions: [{ id: "r" }] }]]);
  if (queried) run.set(queried.oracle.endpoint.split("?")[0], { ok: true });
  const mapped = bodiesByOracleEndpoint(run);
  assert.ok(mapped.has(region.oracle.endpoint));
  if (queried) assert.ok(mapped.has(queried.oracle.endpoint), "query-stripped fallback should match");
});

console.log(`\nskill.test: ${passed} checks passed`);
