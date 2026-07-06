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
import {
  isFieldInvariant,
  isTemplateInvariant,
  isValidInvariant,
  invariantId,
  verifiedInvariantsByStep,
  type FieldInvariant,
  type Invariant,
  type InvariantsArtifact,
} from "./types.js";
import {
  deterministicInvariantsByStep,
  deterministicInvariantsForCandidate,
  mergeInvariantMaps,
} from "./deterministic.js";
import { emitSpec } from "../emit.js";
import type { Candidate } from "../load.js";
import type { FlowPlan, OasSpecs, StepPlan } from "../resolve.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const inv = (over: Partial<FieldInvariant> = {}): FieldInvariant => ({
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
check("parses approved template invariants and drops unknown templates", () => {
  const good = parseInvariantResponse(
    JSON.stringify([{ kind: "template", template: "cart_totals_balance", stepTitle: "POST /x", path: "cart", rationale: "r" }])
  );
  assert.equal(good.length, 1);
  assert.equal(isTemplateInvariant(good[0]) && good[0].template, "cart_totals_balance");

  const bad = parseInvariantResponse(
    JSON.stringify([{ kind: "template", template: "made_up_formula", stepTitle: "POST /x", path: "cart", rationale: "r" }])
  );
  assert.equal(bad.length, 0);
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
  assert.equal(
    evaluateInvariant({ message: "bad login" }, inv({ path: "token", matcher: "toBeUndefined", expected: undefined })).pass,
    true
  );
});
check("evaluate approved templates over known-good bodies", () => {
  assert.equal(
    evaluateInvariant(
      { cart: { total: 1200, item_total: 1000, shipping_total: 300, tax_total: 100, discount_total: 200 } },
      {
        kind: "template",
        template: "cart_totals_balance",
        stepTitle: "POST /store/carts",
        path: "cart",
        rationale: "cart totals balance",
        source: "ai-proposed",
        verified: false,
      }
    ).pass,
    true
  );
  assert.equal(
    evaluateInvariant(
      { type: "cart", cart: {} },
      {
        kind: "template",
        template: "checkout_returns_order",
        stepTitle: "POST /store/carts/{id}/complete",
        path: "",
        rationale: "checkout returned an order",
        source: "ai-proposed",
        verified: false,
      }
    ).pass,
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
check("absence matcher renders no argument", () => {
  const code = renderInvariants("b", [inv({ path: "token", matcher: "toBeUndefined", expected: undefined })]);
  assert.match(code, /getPath\(b, "token"\);/);
  assert.match(code, /\.toBeUndefined\(\);/);
});
check("template invariants render approved helper calls", () => {
  const code = renderInvariants("b", [{
    kind: "template",
    template: "cart_totals_balance",
    stepTitle: "POST /store/carts",
    path: "cart",
    rationale: "cart totals balance",
    source: "deterministic",
    verified: true,
  }]);
  assert.match(code, /const bTemplate0 = getPath\(b, "cart"\);/);
  assert.match(code, /assertCartTotalsBalance\(bTemplate0,/);
});

console.log("invariants: artifact lookup");
check("invariantId is deterministic and changes with identity fields", () => {
  const first = invariantId("flow", inv());
  assert.equal(first, invariantId("flow", inv()));
  assert.equal(first.length, 64);
  assert.notEqual(first, invariantId("flow", inv({ expected: "cart" })));
  assert.notEqual(first, invariantId("other-flow", inv()));
});
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

console.log("invariants: deterministic business assertions");
check("deterministic source covers successful customer/admin login tokens", () => {
  const customer = deterministicInvariantsForCandidate(cand({
    steps: [{ method: "POST", endpoint: "/auth/customer/emailpass", expected_status: 200 }],
  }));
  const admin = deterministicInvariantsForCandidate(cand({
    persona: "admin_operator",
    attributes: { requires_auth: false, is_admin: true, has_errors: false },
    steps: [{ method: "POST", endpoint: "/auth/user/emailpass", expected_status: 200 }],
  }));
  assert.equal(customer[0].source, "deterministic");
  assert.equal(customer[0].verified, true);
  assert.equal(isTemplateInvariant(customer[0]) && customer[0].template, "auth_success_token");
  assert.equal(customer.filter(isFieldInvariant)[0].path, "token.length");
  assert.equal(isTemplateInvariant(admin[0]) && admin[0].template, "auth_success_token");
  assert.equal(admin.filter(isFieldInvariant)[0].path, "token.length");
});
check("deterministic source covers failed customer login without a token", () => {
  const out = deterministicInvariantsForCandidate(cand({
    attributes: { requires_auth: false, is_admin: false, has_errors: true },
    steps: [{ method: "POST", endpoint: "/auth/customer/emailpass", expected_status: 401 }],
  }));
  assert.equal(isTemplateInvariant(out[0]) && out[0].template, "auth_failure_error");
  assert.deepEqual(out.filter(isFieldInvariant).map((i) => `${i.path}:${i.matcher}`), [
    "token:toBeUndefined",
    "message:toBeDefined",
    "type:toBeDefined",
  ]);
  assert.equal(out.every((i) => i.source === "deterministic" && i.verified && i.polarity === "error"), true);
});
check("deterministic checkout success asserts order discriminator only on happy flows", () => {
  const success = deterministicInvariantsForCandidate(cand({
    steps: [{ method: "POST", endpoint: "/store/carts/{id}/complete", expected_status: 200 }],
  }));
  assert.deepEqual(success.filter(isTemplateInvariant).map((i) => `${i.path}:${i.template}`), [
    ":checkout_returns_order",
    "order:order_totals_balance",
  ]);
  assert.deepEqual(success.filter(isFieldInvariant).map((i) => `${i.path}:${i.matcher}:${i.expected ?? ""}`), [
    "type:toBe:order",
    "order.id:toBeDefined:",
    "order.status:toBe:pending",
  ]);

  const errorFlow = deterministicInvariantsForCandidate(cand({
    attributes: { requires_auth: true, is_admin: false, has_errors: true },
    steps: [{ method: "POST", endpoint: "/store/carts/{id}/complete", expected_status: 200 }],
  }));
  assert.equal(errorFlow.length, 0);
});
check("deterministic invalid promo soft-failure is selected only for clearly invalid promo payloads", () => {
  const invalidPromo = deterministicInvariantsForCandidate(cand({
    steps: [{
      method: "POST",
      endpoint: "/store/carts/{id}",
      expected_status: 200,
      request_payload: { promo_codes: ["INVALID_PROMO_DO_NOT_SEED"] },
    }],
  }));
  assert.deepEqual(invalidPromo.filter(isTemplateInvariant).map((i) => `${i.path}:${i.template}`), [
    "cart:cart_totals_balance",
    "cart:invalid_promotion_not_applied",
  ]);
  assert.deepEqual(invalidPromo.filter(isFieldInvariant).map((i) => `${i.path}:${i.matcher}:${i.expected}`), [
    "cart.promotions.length:toBe:0",
    "cart.discount_total:toBe:0",
  ]);

  const unknownIntent = deterministicInvariantsForCandidate(cand({
    steps: [{
      method: "POST",
      endpoint: "/store/carts/{id}",
      expected_status: 200,
      request_payload: { promo_codes: ["SUMMER10"] },
    }],
  }));
  assert.deepEqual(unknownIntent.filter(isTemplateInvariant).map((i) => i.template), ["cart_totals_balance"]);
  assert.equal(unknownIntent.some((i) => isTemplateInvariant(i) && i.template === "invalid_promotion_not_applied"), false);
});
check("deterministic source covers cart totals and admin cancellation templates", () => {
  const cart = deterministicInvariantsForCandidate(cand({
    steps: [{ method: "POST", endpoint: "/store/carts", expected_status: 200 }],
  }));
  assert.deepEqual(cart.filter(isTemplateInvariant).map((i) => `${i.path}:${i.template}`), ["cart:cart_totals_balance"]);

  const admin = deterministicInvariantsForCandidate(cand({
    persona: "admin_operator",
    attributes: { requires_auth: true, is_admin: true, has_errors: false },
    steps: [{ method: "POST", endpoint: "/admin/orders/{id}/cancel", expected_status: 200 }],
  }));
  assert.equal(isTemplateInvariant(admin[0]) && admin[0].template, "admin_order_canceled");
});
check("mergeInvariantMaps combines baked and deterministic invariants, preferring deterministic duplicates", () => {
  const ai = inv({ source: "ai-proposed", path: "type", matcher: "toBe", expected: "order" });
  const det = inv({ source: "deterministic", path: "type", matcher: "toBe", expected: "order" });
  const other = inv({ source: "ai-proposed", path: "order.id", matcher: "toBeDefined", expected: undefined });
  const merged = mergeInvariantMaps(
    new Map([[ai.stepTitle, [ai, other]]]),
    new Map([[det.stepTitle, [det]]])
  );
  const list = merged.get(ai.stepTitle) ?? [];
  assert.equal(list.length, 2);
  assert.equal(list.find((i) => i.path === "type")?.source, "deterministic");
});

const stepPlan = (step: Candidate["steps"][number]): StepPlan => ({
  step,
  resolveCalls: [],
  path: { template: step.endpoint, params: [] },
  query: {},
  body: { kind: "empty" },
  auth: "none",
  captures: {},
});

check("emit renders deterministic customer login invariant in setup when success login step is setup-owned", () => {
  const candidate = cand({
    steps: [{ method: "POST", endpoint: "/auth/customer/emailpass", expected_status: 200 }],
  });
  const plan: FlowPlan = { steps: [stepPlan(candidate.steps[0])], errors: [] };
  const source = emitSpec({
    candidate,
    plan,
    golden: false,
    invariantsByStep: deterministicInvariantsByStep(candidate),
  }).source;
  assert.match(source, /const loginRespBody = await safeJson\(loginResp\);/);
  assert.match(source, /import \{ assertAuthSuccessToken \} from "..\/..\/_golden\/business-invariants\.js";/);
  assert.match(source, /invariant \(deterministic\): successful email\/password login returns a non-empty session token/);
  assert.match(source, /getPath\(loginRespBody, "token.length"\)/);
  assert.doesNotMatch(source, /await test\.step\("POST \/auth\/customer\/emailpass"/);
});
check("emit imports and calls business templates for cart flows", () => {
  const candidate = cand({
    steps: [{ method: "POST", endpoint: "/store/carts", expected_status: 200 }],
  });
  const plan: FlowPlan = { steps: [stepPlan(candidate.steps[0])], errors: [] };
  const source = emitSpec({
    candidate,
    plan,
    golden: false,
    invariantsByStep: deterministicInvariantsByStep(candidate),
  }).source;
  assert.match(source, /import \{ assertCartTotalsBalance \} from "..\/..\/_golden\/business-invariants\.js";/);
  assert.match(source, /assertCartTotalsBalance\(resp0BodyTemplate0,/);
});
check("emit keeps failed customer login as a real step and renders no-token assertions", () => {
  const candidate = cand({
    attributes: { requires_auth: true, is_admin: false, has_errors: true },
    steps: [{ method: "POST", endpoint: "/auth/customer/emailpass", expected_status: 401 }],
  });
  const plan: FlowPlan = { steps: [stepPlan(candidate.steps[0])], errors: [] };
  const source = emitSpec({
    candidate,
    plan,
    golden: false,
    invariantsByStep: deterministicInvariantsByStep(candidate),
  }).source;
  assert.match(source, /await test\.step\("POST \/auth\/customer\/emailpass"/);
  assert.match(source, /getPath\(resp0Body, "token"\)/);
  assert.match(source, /\.toBeUndefined\(\);/);
  assert.match(source, /getPath\(resp0Body, "message"\)/);
  assert.match(source, /getPath\(resp0Body, "type"\)/);
});

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
