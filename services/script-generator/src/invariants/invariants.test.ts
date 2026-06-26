/**
 * Invariant-layer unit tests (run: `tsx src/invariants/invariants.test.ts`).
 * Pure functions only — no agent, no backend. Covers the three trust-critical
 * seams: parse (reject hallucinations), evaluate (matcher correctness), render
 * (deterministic codegen), and the verify bake gate.
 */
import assert from "node:assert/strict";
import {
  buildInvariantPrompt,
  flowCacheKey,
  flowPolarity,
  parseInvariantResponse,
  type ProposalContext,
} from "./propose.js";
import { evaluateInvariant, getPath, verifyInvariants } from "./evaluate.js";
import { renderInvariants } from "./render.js";
import { digestSlug, parseDigestFile } from "./digest.js";
import { stepTitle, workflowFileFor, workflowSourceHash } from "./codebase.js";
import { isValidInvariant, verifiedInvariantsByStep, type Invariant, type InvariantsArtifact } from "./types.js";
import type { Candidate } from "../load.js";
import type { OasSpecs } from "../resolve.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const inv = (over: Partial<Invariant> = {}): Invariant => ({
  stepTitle: "POST /store/carts/{id}/complete",
  path: "type",
  matcher: "toBe",
  expected: "order",
  rationale: "cart converted to an order",
  source: "ai-proposed",
  verified: true,
  ...over,
});

console.log("invariants: parse");
check("parses a well-formed array and stamps provenance", () => {
  const out = parseInvariantResponse(
    JSON.stringify([{ stepTitle: "POST /x", path: "type", matcher: "toBe", expected: "order", rationale: "r" }])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "ai-proposed");
  assert.equal(out[0].verified, false);
});
check("strips a ```json fence", () => {
  const out = parseInvariantResponse('```json\n[{"stepTitle":"P","path":"a","matcher":"toBeDefined","rationale":"r"}]\n```');
  assert.equal(out.length, 1);
});
check("drops a hallucinated matcher", () => {
  const out = parseInvariantResponse(JSON.stringify([{ stepTitle: "P", path: "a", matcher: "toBeMagic", rationale: "r" }]));
  assert.equal(out.length, 0);
});
check("drops a value matcher missing its argument", () => {
  const out = parseInvariantResponse(JSON.stringify([{ stepTitle: "P", path: "a", matcher: "toBe", rationale: "r" }]));
  assert.equal(out.length, 0);
});
check("non-array / garbage yields zero, never throws", () => {
  assert.equal(parseInvariantResponse("not json").length, 0);
  assert.equal(parseInvariantResponse('{"a":1}').length, 0);
});

console.log("invariants: validity");
check("nullary matcher must NOT carry expected", () => {
  assert.equal(isValidInvariant(inv({ matcher: "toBeDefined", expected: "x" })), false);
  assert.equal(isValidInvariant({ ...inv({ matcher: "toBeDefined" }), expected: undefined }), true);
});

console.log("invariants: getPath / evaluate");
check("getPath reads nested + array .length, undefined on miss", () => {
  const body = { cart: { items: [{ id: "a" }, { id: "b" }] }, type: "order" };
  assert.equal(getPath(body, "type"), "order");
  assert.equal(getPath(body, "cart.items.length"), 2);
  assert.equal(getPath(body, "cart.items[0].id"), "a");
  assert.equal(getPath(body, "missing.deep.path"), undefined);
});
check("evaluate toBe / toBeGreaterThan / toBeDefined", () => {
  assert.equal(evaluateInvariant({ type: "order" }, inv()).pass, true);
  assert.equal(evaluateInvariant({ type: "cart" }, inv()).pass, false);
  assert.equal(
    evaluateInvariant({ cart: { items: [1, 2] } }, inv({ path: "cart.items.length", matcher: "toBeGreaterThan", expected: 0 })).pass,
    true
  );
  assert.equal(
    evaluateInvariant({ order: {} }, inv({ path: "order.payment_status", matcher: "toBeDefined", expected: undefined })).pass,
    false
  );
});

console.log("invariants: verify bake gate");
check("only invariants that hold on known-good bodies become verified", () => {
  const proposals = [
    inv({ verified: false }),
    inv({ path: "order.items.length", matcher: "toBeGreaterThan", expected: 0, verified: false }),
    inv({ stepTitle: "GET /missing", path: "x", matcher: "toBeDefined", expected: undefined, verified: false }),
  ];
  const bodies = new Map<string, unknown>([
    ["POST /store/carts/{id}/complete", { type: "order", order: { items: [{ id: "a" }] } }],
  ]);
  const out = verifyInvariants(proposals, bodies);
  assert.equal(out[0].verified, true); // type === order held
  assert.equal(out[1].verified, true); // order.items.length > 0 held
  assert.equal(out[2].verified, false); // no captured body for that step -> never baked
});

console.log("invariants: render");
check("renders a deterministic expect with getPath + label", () => {
  const code = renderInvariants("resp7Body", [inv()]);
  assert.match(code, /const resp7BodyInv0 = getPath\(resp7Body, "type"\);/);
  assert.match(code, /expect\(resp7BodyInv0, ".*cart converted.*"\)\.toBe\("order"\);/);
});
check("nullary matcher renders no argument", () => {
  const code = renderInvariants("b", [inv({ matcher: "toBeDefined", expected: undefined })]);
  assert.match(code, /\.toBeDefined\(\);/);
});

console.log("invariants: artifact lookup");
check("verifiedInvariantsByStep groups verified-only by step title", () => {
  const artifact: InvariantsArtifact = {
    generated_at: "t",
    flows: {
      sig: {
        flow_name: "f",
        invariants: [inv({ verified: true }), inv({ path: "order.id", matcher: "toBeDefined", expected: undefined, verified: false })],
      },
    },
  };
  const byStep = verifiedInvariantsByStep(artifact, "sig");
  assert.equal(byStep.get("POST /store/carts/{id}/complete")?.length, 1);
  assert.equal(verifiedInvariantsByStep(artifact, "unknown").size, 0);
});

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  flow_name: "f",
  persona: "registered_customer",
  persona_source: "emergent_attributes",
  attributes: { requires_auth: true, is_admin: false, has_errors: false },
  priority: "high",
  support: 3,
  score: 1,
  signature: "sig",
  assertion_hints: { fields: [], source: "x" },
  anomaly_note: null,
  source_sessions: [],
  steps: [{ method: "POST", endpoint: "/store/carts/{id}/complete", expected_status: 200 }],
  ...over,
});
const errorAttrs = { requires_auth: false, is_admin: false, has_errors: true };
const emptySpecs = {
  store: { paths: {}, components: { schemas: {} } },
  admin: { paths: {}, components: { schemas: {} } },
} as unknown as OasSpecs;

console.log("invariants: polarity + negative mode");
check("parseInvariantResponse stamps polarity (defaulting to success)", () => {
  const err = parseInvariantResponse(
    JSON.stringify([{ stepTitle: "P", path: "type", matcher: "toBe", expected: "not_allowed", rationale: "r" }]),
    "error"
  );
  assert.equal(err[0].polarity, "error");
  const ok = parseInvariantResponse(JSON.stringify([{ stepTitle: "P", path: "type", matcher: "toBe", expected: "order", rationale: "r" }]));
  assert.equal(ok[0].polarity, "success");
});
check("isValidInvariant rejects a bad polarity, accepts a known one", () => {
  assert.equal(isValidInvariant({ ...inv(), polarity: "weird" }), false);
  assert.equal(isValidInvariant(inv({ polarity: "error" })), true);
});
check("error flow yields a negative-mode prompt; happy flow a success prompt", () => {
  assert.match(buildInvariantPrompt(cand({ attributes: errorAttrs }), emptySpecs), /NEGATIVE \(error-path\)/);
  assert.match(buildInvariantPrompt(cand(), emptySpecs), /INVARIANTS over the RESPONSE BODY/);
});
check("codebase context (gate + digest) is injected into the prompt", () => {
  const ctx: ProposalContext = {
    gateContract: "GATE_SRC_TOKEN",
    digestByStep: new Map([["POST /store/carts/{id}/complete", "DIGEST_TOKEN"]]),
  };
  const p = buildInvariantPrompt(cand(), emptySpecs, ctx);
  assert.match(p, /Custom auth gate/);
  assert.match(p, /GATE_SRC_TOKEN/);
  assert.match(p, /DIGEST_TOKEN/);
});
check("flowPolarity follows has_errors", () => {
  assert.equal(flowPolarity(cand()), "success");
  assert.equal(flowPolarity(cand({ attributes: errorAttrs })), "error");
});

console.log("invariants: template cache key (#2)");
check("flowCacheKey is deterministic and sensitive to gate + digest changes", () => {
  const base: ProposalContext = { gateContract: "G", digestByStep: new Map([["POST /store/carts/{id}/complete", "D1"]]) };
  const k1 = flowCacheKey(cand(), emptySpecs, base);
  assert.equal(k1, flowCacheKey(cand(), emptySpecs, base)); // deterministic
  const digestChanged: ProposalContext = { gateContract: "G", digestByStep: new Map([["POST /store/carts/{id}/complete", "D2"]]) };
  assert.notEqual(k1, flowCacheKey(cand(), emptySpecs, digestChanged)); // digest drift -> re-propose
  const gateChanged: ProposalContext = { gateContract: "G2", digestByStep: base.digestByStep };
  assert.notEqual(k1, flowCacheKey(cand(), emptySpecs, gateChanged)); // gate change -> re-propose
});

console.log("invariants: digest cache (#1)");
check("digestSlug + parseDigestFile round-trip; null without frontmatter hash", () => {
  assert.equal(digestSlug("POST", "/store/carts/{id}/complete"), "post_store_carts_id_complete");
  const parsed = parseDigestFile("---\nendpoint: X\nsource_hash: abc123\n---\n\n## Guards\n- body\n");
  assert.equal(parsed?.sourceHash, "abc123");
  assert.match(parsed!.body, /## Guards/);
  assert.equal(parseDigestFile("no frontmatter here"), null);
});

console.log("invariants: codebase map");
check("mapped endpoint resolves to real core-flows source; unmapped hashes to empty", () => {
  assert.equal(stepTitle("POST", "/x"), "POST /x");
  const f = workflowFileFor("POST", "/store/carts/{id}/complete");
  if (f) {
    assert.ok(f.endsWith("complete-cart.js"));
    assert.equal(workflowSourceHash("POST", "/store/carts/{id}/complete").length, 64);
  }
  assert.equal(workflowSourceHash("GET", "/totally/unmapped"), "");
});

console.log(`\n${passed} checks passed.`);
