import { strict as assert } from "node:assert";
import { selectBusinessScenarios, type ScenarioCandidate } from "./scenarios.js";

const step = (method: string, endpoint: string, expected_status = 200) => ({
  method,
  endpoint,
  expected_status,
});
const candidate = (
  signature: string,
  persona: string,
  flow_name: string,
  steps: ScenarioCandidate["steps"],
  support = 1,
  score = 0.5
): ScenarioCandidate => ({ signature, persona, flow_name, steps, support, score });

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("checkout route variants collapse to the most complete representative", () => {
  const short = candidate("a".repeat(64), "registered_customer", "checkout", [
    step("POST", "/store/carts/{id}/line-items"),
    step("POST", "/store/payment-collections"),
  ], 20);
  const complete = candidate("b".repeat(64), "registered_customer", "end to end purchase", [
    ...short.steps,
    step("POST", "/store/payment-collections/{id}/payment-sessions"),
    step("POST", "/store/carts/{id}/complete"),
    step("GET", "/store/orders/{id}"),
  ], 5);
  const selected = selectBusinessScenarios([short, complete]);
  assert.equal(selected.representatives.length, 1);
  assert.equal(selected.representatives[0].candidate.signature, complete.signature);
  assert.equal(selected.representatives[0].scenario_name, "Checkout — Standard purchase");
  assert.equal(selected.representatives[0].variants.length, 2);
});

check("material checkout scenarios remain separate and receive deterministic names", () => {
  const base = [
    step("POST", "/store/carts/{id}/line-items"),
    step("POST", "/store/carts/{id}/complete"),
  ];
  const standard = candidate("a".repeat(64), "registered_customer", "random llm title", base);
  const multi = candidate("b".repeat(64), "registered_customer", "another title", [
    step("POST", "/store/carts/{id}/line-items"),
    step("POST", "/store/carts/{id}/line-items"),
    step("POST", "/store/carts/{id}/complete"),
  ]);
  const payment = candidate("c".repeat(64), "registered_customer", "third title", [
    step("POST", "/store/carts/{id}/line-items"),
    step("POST", "/store/payment-collections", 400),
  ]);
  const names = selectBusinessScenarios([standard, multi, payment]).representatives
    .map((item) => item.scenario_name)
    .sort();
  assert.deepEqual(names, [
    "Checkout — Multi-item cart",
    "Checkout — Payment failure",
    "Checkout — Standard purchase",
  ]);
});

check("personas and authentication boundaries never merge", () => {
  const guest = candidate("a".repeat(64), "guest_shopper", "guest failure", [
    step("POST", "/store/carts", 401),
  ]);
  const customer = candidate("b".repeat(64), "registered_customer", "login failure", [
    step("POST", "/auth/customer/emailpass", 401),
  ]);
  const selected = selectBusinessScenarios([guest, customer]);
  assert.equal(selected.representatives.length, 2);
  assert.deepEqual(
    new Set(selected.representatives.map((item) => item.scenario_name)),
    new Set(["Checkout — Authentication failure", "Authentication — Login failure"])
  );
});

check("an approved current candidate wins representative selection", () => {
  const approved = candidate("a".repeat(64), "guest_shopper", "approved browse", [
    step("GET", "/store/products"),
  ], 2);
  const newer = candidate("b".repeat(64), "guest_shopper", "larger browse", [
    step("GET", "/store/regions"),
    step("GET", "/store/products"),
  ], 200);
  const selected = selectBusinessScenarios([approved, newer], new Set([approved.signature]));
  assert.equal(selected.representatives[0].candidate.signature, approved.signature);
});

console.log(`\n${passed} scenario-selection checks passed`);
