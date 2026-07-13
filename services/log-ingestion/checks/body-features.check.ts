import assert from "node:assert/strict";

import {
  classifySensitiveKey,
  reduceValue,
} from "../../../apps/medusa/apps/backend/src/api/body-redaction.ts";
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

const rawStructuredBody = {
  shipping_address: {
    city: "Hanoi",
    latitude: 21.0285,
    verified: true,
    lines: ["private street"],
  },
  payment_details: {
    amount: 123.45,
    reusable: true,
  },
  payment_status: "captured",
  accounting_code: "revenue",
  paper_size: "A4",
  document_type: "invoice",
  payment_collection: {
    payment_sessions: [
      {
        id: "ps_123",
        status: "pending",
        provider_id: "stripe",
        amount: 12345,
        currency_code: "usd",
        is_selected: true,
        quantity: 2,
      },
    ],
  },
  order: {
    payment_collections: [
      {
        payments: [
          {
            status: "captured",
            provider_id: "stripe",
            amount: 12345,
          },
        ],
      },
    ],
  },
};
const structuredMaskedBody = reduceValue(rawStructuredBody);
const serializedStructuredBody = JSON.stringify(structuredMaskedBody);
assert.equal(serializedStructuredBody.includes("Hanoi"), false);
assert.equal(serializedStructuredBody.includes("21.0285"), false);
assert.equal(serializedStructuredBody.includes("private street"), false);
assert.equal(serializedStructuredBody.includes("123.45"), false);
assert.equal(serializedStructuredBody.includes("pending"), true);
assert.equal(serializedStructuredBody.includes("stripe"), true);
assert.equal(serializedStructuredBody.includes("12345"), true);
assert.equal(serializedStructuredBody.includes("captured"), true);
const structuredMaskedFeatures = extractBodyFeatures(structuredMaskedBody);

assert.ok(
  structuredMaskedFeatures.primitive_type_paths.some(
    (entry) =>
      entry.path === "$.shipping_address.latitude" && entry.type === "number"
  )
);
assert.ok(
  structuredMaskedFeatures.primitive_type_paths.some(
    (entry) =>
      entry.path === "$.shipping_address.verified" && entry.type === "boolean"
  )
);
assert.ok(
  structuredMaskedFeatures.masked_field_paths.includes(
    "$.shipping_address.latitude"
  )
);
assert.ok(
  structuredMaskedFeatures.masked_field_paths.includes(
    "$.shipping_address.verified"
  )
);
assert.ok(
  structuredMaskedFeatures.masked_field_paths.includes(
    "$.payment_details.amount"
  )
);
assert.equal(
  structuredMaskedFeatures.masked_field_paths.includes("$.payment_status"),
  false
);
assert.equal(
  structuredMaskedFeatures.masked_field_paths.includes("$.accounting_code"),
  false
);
assert.equal(
  structuredMaskedFeatures.masked_field_paths.includes("$.paper_size"),
  false
);
assert.equal(
  structuredMaskedFeatures.masked_field_paths.includes("$.document_type"),
  false
);
assert.ok(
  structuredMaskedFeatures.safe_scalar_hints.some(
    (hint) => hint.path === "$.payment_status" && hint.hint === "captured"
  )
);
assert.ok(
  structuredMaskedFeatures.safe_scalar_hints.some(
    (hint) =>
      hint.path === "$.payment_collection.payment_sessions[].status" &&
      hint.hint === "pending"
  )
);
assert.ok(
  structuredMaskedFeatures.safe_scalar_hints.some(
    (hint) =>
      hint.path === "$.payment_collection.payment_sessions[].provider_id" &&
      hint.hint === "stripe"
  )
);
assert.ok(
  structuredMaskedFeatures.safe_scalar_hints.some(
    (hint) =>
      hint.path === "$.payment_collection.payment_sessions[].amount" &&
      hint.hint === "101+"
  )
);
assert.ok(
  structuredMaskedFeatures.safe_scalar_hints.some(
    (hint) =>
      hint.path === "$.payment_collection.payment_sessions[].currency_code" &&
      hint.hint === "usd"
  )
);
for (const visiblePaymentPath of [
  "$.payment_collection.payment_sessions",
  "$.payment_collection.payment_sessions[].id",
  "$.payment_collection.payment_sessions[].status",
  "$.payment_collection.payment_sessions[].provider_id",
  "$.payment_collection.payment_sessions[].amount",
  "$.payment_collection.payment_sessions[].currency_code",
  "$.payment_collection.payment_sessions[].is_selected",
  "$.payment_collection.payment_sessions[].quantity",
  "$.order.payment_collections[].payments",
  "$.order.payment_collections[].payments[].status",
  "$.order.payment_collections[].payments[].provider_id",
  "$.order.payment_collections[].payments[].amount",
]) {
  assert.equal(
    structuredMaskedFeatures.masked_field_paths.includes(visiblePaymentPath),
    false,
    `${visiblePaymentPath} should not be labeled masked`
  );
}
assert.equal(
  structuredMaskedFeatures.safe_scalar_hints.some((hint) =>
    hint.path.startsWith("$.shipping_address")
  ),
  false
);

assert.equal(classifySensitiveKey("payment_sessions"), null);
assert.equal(classifySensitiveKey("payments"), null);
assert.equal(classifySensitiveKey("payment_details"), "container");
assert.equal(classifySensitiveKey("shipping_address"), "container");
assert.equal(classifySensitiveKey("email"), "scalar");
assert.equal(classifySensitiveKey("token"), "scalar");

function maskedLeafPaths(raw: unknown, reduced: unknown, path = "$"): string[] {
  if (raw === null || raw === undefined || reduced === null || reduced === undefined) {
    return [];
  }
  if (Array.isArray(raw) && Array.isArray(reduced)) {
    return raw.flatMap((item, index) =>
      maskedLeafPaths(item, reduced[index], `${path}[]`)
    );
  }
  if (
    typeof raw === "object" &&
    typeof reduced === "object" &&
    !Array.isArray(raw) &&
    !Array.isArray(reduced)
  ) {
    return Object.keys(raw as Record<string, unknown>).flatMap((key) =>
      maskedLeafPaths(
        (raw as Record<string, unknown>)[key],
        (reduced as Record<string, unknown>)[key],
        path === "$" ? `$.${key}` : `${path}.${key}`
      )
    );
  }
  if (
    (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") &&
    raw !== reduced &&
    (reduced === "[masked]" || reduced === 0 || reduced === false)
  ) {
    return [path];
  }
  return [];
}

const symmetryRawBody = {
  shipping_address: {
    city: "Hanoi",
    latitude: 21.0285,
    verified: true,
  },
  payment_details: {
    amount: 123.45,
    reusable: true,
  },
  credentials: {
    expires_in: 3600,
    active: true,
    token: "secret-token",
  },
  payment_collection: {
    payment_sessions: [
      {
        status: "pending",
        provider_id: "stripe",
        amount: 1000,
        is_selected: true,
      },
    ],
  },
};
const symmetryMaskedBody = reduceValue(symmetryRawBody);
const symmetryFeatures = extractBodyFeatures(symmetryMaskedBody);
for (const path of maskedLeafPaths(symmetryRawBody, symmetryMaskedBody)) {
  assert.ok(
    symmetryFeatures.masked_field_paths.includes(path),
    `${path} was masked by body-redaction but not labeled by ingestion`
  );
}
assert.equal(
  maskedLeafPaths(symmetryRawBody, symmetryMaskedBody).includes(
    "$.payment_collection.payment_sessions[].amount"
  ),
  false
);

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
