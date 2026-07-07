import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedRunResult, NormalizedStep, NormalizedTest } from "../collect.js";
import type { EvalFault } from "./catalog.js";
import { classifyFault } from "./detect.js";

const ENDPOINT = "POST /store/carts/{id}/complete";

const FAULT: EvalFault = {
  id: "carts_complete_500",
  title: "t",
  faultClass: "status",
  targetEndpoint: ENDPOINT,
  expectedSignal: "s",
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

function testCase(name: string, steps: NormalizedStep[]): NormalizedTest {
  return {
    persona: "registered_customer",
    flow_name: name,
    flow_signature: name,
    source_sessions: [],
    project: "customer",
    file: `${name}.spec.ts`,
    title: name,
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

test("caught: net-new target-endpoint failure vs green baseline", () => {
  const baseline = result([testCase("checkout", [step(ENDPOINT, "passed")])]);
  const faulted = result([
    testCase("checkout", [step(ENDPOINT, "failed", "Expected: 200\nReceived: 500")]),
  ]);
  const v = classifyFault(FAULT, faulted, baseline);
  assert.equal(v.caught, true);
  assert.equal(v.catchingTest, "checkout");
  assert.match(v.evidence ?? "", /Expected: 200/);
  assert.equal(v.baselinePreexistingFailure, false);
});

test("not caught: fault run has no target-endpoint failure", () => {
  const baseline = result([testCase("checkout", [step(ENDPOINT, "passed")])]);
  const faulted = result([testCase("checkout", [step(ENDPOINT, "passed")])]);
  const v = classifyFault(FAULT, faulted, baseline);
  assert.equal(v.caught, false);
  assert.equal(v.catchingTest, null);
});

test("not attributable: endpoint already red at baseline is not credited", () => {
  const baseline = result([testCase("checkout", [step(ENDPOINT, "failed", "pre-existing")])]);
  const faulted = result([testCase("checkout", [step(ENDPOINT, "failed", "still red")])]);
  const v = classifyFault(FAULT, faulted, baseline);
  assert.equal(v.caught, false);
  assert.equal(v.baselinePreexistingFailure, true);
});

test("a failure on a DIFFERENT endpoint does not count as caught", () => {
  const baseline = result([testCase("checkout", [step(ENDPOINT, "passed")])]);
  const faulted = result([
    testCase("checkout", [step("GET /store/orders/{id}", "failed", "unrelated"), step(ENDPOINT, "passed")]),
  ]);
  const v = classifyFault(FAULT, faulted, baseline);
  assert.equal(v.caught, false);
});

test("no baseline: any target-endpoint failure counts (attribution skipped)", () => {
  const faulted = result([testCase("checkout", [step(ENDPOINT, "failed", "boom")])]);
  const v = classifyFault(FAULT, faulted, null);
  assert.equal(v.caught, true);
  assert.equal(v.baselinePreexistingFailure, false);
});
