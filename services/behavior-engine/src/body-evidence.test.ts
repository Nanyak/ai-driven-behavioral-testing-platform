import { strict as assert } from "node:assert";
import { aggregateRequestBodyEvidence } from "./body-evidence.js";
import type { FlowStep, RequestBodyFeatures } from "./io/sessions.js";

function features(
  paths: string[],
  options: {
    masked?: string[];
    hints?: RequestBodyFeatures["safe_scalar_hints"];
  } = {}
): RequestBodyFeatures {
  return {
    present: true,
    kind: "object",
    field_paths: paths,
    masked_field_paths: options.masked ?? [],
    primitive_type_paths: paths.map((path) => ({ path, type: "string" })),
    array_lengths: [],
    safe_scalar_hints: options.hints ?? [],
    shape_hash: paths.join("|"),
    truncated: false,
  };
}

function step(body: RequestBodyFeatures): FlowStep {
  return {
    method: "POST",
    endpoint: "/demo",
    event: null,
    status: 200,
    trace_id: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    request_payload: { must_not: "leak" },
    request_body_features: body,
    has_error: false,
  };
}

const sessions = [
  { steps: [step(features(["$.title", "$.status"], { hints: [{ path: "$.status", type: "string", hint: "published" }] }))] },
  { steps: [step(features(["$.title", "$.status"], { hints: [{ path: "$.status", type: "string", hint: "published" }] }))] },
  { steps: [step(features(["$.title", "$.status", "$.email"], { masked: ["$.email"], hints: [{ path: "$.status", type: "string", hint: "published" }] }))] },
  { steps: [step(features(["$.title"]))] },
];

const evidence = aggregateRequestBodyEvidence(sessions, "POST", "/demo", 200);
assert.ok(evidence);
assert.equal(evidence.sample_count, 4);
assert.equal(evidence.fields.find((field) => field.path === "$.title")?.presence_rate, 1);
assert.equal(evidence.fields.find((field) => field.path === "$.status")?.presence_rate, 0.75);
assert.equal(evidence.fields.find((field) => field.path === "$.email")?.masked, true);
assert.deepEqual(evidence.fields.find((field) => field.path === "$.status")?.safe_hints, [
  { type: "string", hint: "published", count: 3 },
]);
assert.equal(JSON.stringify(evidence).includes("must_not"), false, "raw request payload is never propagated");

console.log("body-evidence.test: 1 check passed");
