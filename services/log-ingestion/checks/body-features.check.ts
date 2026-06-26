import assert from "node:assert/strict";

import { buildSessionFlows, extractBodyFeatures } from "../src/pipeline.js";
import type { RawLogDoc } from "../src/types.js";

const bodyA = {
  status: "pending",
  note: "please leave this unbounded free text out of hints",
  gift: false,
  customer: {
    email: "[MASKED]",
    name: "Ada Lovelace",
  },
  items: [
    {
      quantity: 2,
      variant_id: "variant_123",
      metadata: {
        token: "***",
      },
    },
  ],
};

const bodyB = {
  items: [
    {
      metadata: {
        token: "***",
      },
      quantity: 2,
      variant_id: "variant_123",
    },
  ],
  customer: {
    name: "Ada Lovelace",
    email: "[MASKED]",
  },
  gift: false,
  note: "please leave this unbounded free text out of hints",
  status: "pending",
};

const features = extractBodyFeatures(bodyA);
const reorderedFeatures = extractBodyFeatures(bodyB);

assert.equal(features.present, true);
assert.equal(features.kind, "object");
assert.deepEqual(features.field_paths, [
  "$.customer",
  "$.customer.email",
  "$.customer.name",
  "$.gift",
  "$.items",
  "$.items[].metadata",
  "$.items[].metadata.token",
  "$.items[].quantity",
  "$.items[].variant_id",
  "$.note",
  "$.status",
]);
assert.deepEqual(features.masked_field_paths, [
  "$.customer.email",
  "$.customer.name",
  "$.items[].metadata.token",
]);
assert.deepEqual(features.array_lengths, [
  { path: "$.items", length: 1, bucket: "1" },
]);
assert.ok(
  features.primitive_type_paths.some(
    (entry) => entry.path === "$.items[].quantity" && entry.type === "number"
  )
);
assert.deepEqual(features.safe_scalar_hints, [
  { path: "$.gift", type: "boolean", hint: false },
  { path: "$.items[].quantity", type: "number", hint: "2-5" },
  { path: "$.status", type: "string", hint: "pending" },
]);
assert.equal(
  features.safe_scalar_hints.some((hint) => hint.path === "$.items[].variant_id"),
  false
);
assert.equal(features.shape_hash, reorderedFeatures.shape_hash);
assert.deepEqual(features.field_paths, reorderedFeatures.field_paths);
assert.deepEqual(features.safe_scalar_hints, reorderedFeatures.safe_scalar_hints);

const absentFeatures = extractBodyFeatures(undefined);
assert.deepEqual(absentFeatures, {
  present: false,
  kind: "absent",
  field_paths: [],
  masked_field_paths: [],
  primitive_type_paths: [],
  array_lengths: [],
  safe_scalar_hints: [],
  shape_hash: null,
  truncated: false,
});

const docs: RawLogDoc[] = [
  {
    timestamp: "2026-06-27T00:00:00.000Z",
    session_id: "s1",
    method: "post",
    endpoint: "/store/carts/cart_123/line-items",
    status: 200,
    request_payload: bodyA,
    response_body: {
      status: "created",
      customer: {
        email: "[MASKED]",
      },
    },
  },
  {
    timestamp: "2026-06-27T00:00:01.000Z",
    session_id: "s1",
    method: "get",
    endpoint: "/store/carts/cart_123",
    status: 200,
  },
];

const result = buildSessionFlows([{ sessionId: "s1", docs }]);
assert.equal(result.sessions.length, 1);
const [firstStep, secondStep] = result.sessions[0].steps;
assert.deepEqual(firstStep.request_payload, bodyA);
assert.equal(firstStep.request_body_features.present, true);
assert.equal(firstStep.response_body_features.present, true);
assert.equal(
  firstStep.response_body_features.safe_scalar_hints.find(
    (hint) => hint.path === "$.status"
  )?.hint,
  "created"
);
assert.equal("response_body" in firstStep, false);
assert.equal(secondStep.request_body_features.present, false);
assert.equal(secondStep.response_body_features.present, false);

console.log("body-features checks passed");
