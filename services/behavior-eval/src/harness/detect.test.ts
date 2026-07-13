import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedRunResult, NormalizedStep, NormalizedTest } from "../../../test-runner/src/collect.js";
import type { Mutant } from "../types.js";
import { classifyMutation } from "./detect.js";

const ENDPOINT = "POST /store/carts/{id}/complete";
const MUTANT: Mutant = {
  id: "m",
  endpoint: ENDPOINT,
  status: 200,
  operator: "drop_field",
  path: "order",
  origin_golden: "goldens/complete.json",
};

function step(endpoint: string, status: NormalizedStep["status"], message: string | null = null): NormalizedStep {
  return {
    endpoint,
    method: endpoint.split(" ")[0],
    expected_status: null,
    actual_status: null,
    status,
    duration_ms: 1,
    golden_diff: null,
    value_diff: null,
    failure_message: message,
  };
}

function testCase(file: string, steps: NormalizedStep[]): NormalizedTest {
  return {
    persona: "registered_customer",
    flow_name: file,
    flow_signature: file,
    source_sessions: [],
    project: "customer",
    file,
    title: file,
    status: steps.some((s) => s.status === "failed") ? "failed" : "passed",
    duration_ms: 1,
    steps,
  };
}

function result(tests: NormalizedTest[]): NormalizedRunResult {
  return {
    generated_at: "now",
    totals: {
      executed: tests.length,
      passed: tests.filter((t) => t.status === "passed").length,
      failed: tests.filter((t) => t.status === "failed").length,
      skipped: 0,
    },
    tests,
  };
}

test("classifies net-new endpoint failure as killed", () => {
  const baseline = result([testCase("checkout.spec.ts", [step(ENDPOINT, "passed")])]);
  const faulted = result([testCase("checkout.spec.ts", [step(ENDPOINT, "failed", "missing order")])]);
  const verdict = classifyMutation(MUTANT, faulted, baseline);
  assert.equal(verdict.killed, true);
  assert.equal(verdict.catchingSpec, "checkout.spec.ts");
  assert.match(verdict.evidence ?? "", /missing order/);
});

test("does not credit pre-existing baseline reds or other endpoint failures", () => {
  const baseline = result([testCase("checkout.spec.ts", [step(ENDPOINT, "failed", "already red")])]);
  const faulted = result([testCase("checkout.spec.ts", [step(ENDPOINT, "failed", "still red")])]);
  assert.equal(classifyMutation(MUTANT, faulted, baseline).killed, false);

  const green = result([testCase("checkout.spec.ts", [step(ENDPOINT, "passed")])]);
  const unrelated = result([testCase("checkout.spec.ts", [step("GET /store/orders/{id}", "failed")])]);
  assert.equal(classifyMutation(MUTANT, unrelated, green).killed, false);
});
