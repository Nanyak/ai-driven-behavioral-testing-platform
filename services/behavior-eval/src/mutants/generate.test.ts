import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoldenResponse } from "../../../golden/src/types.js";
import { generateMutants } from "./generate.js";

const golden: GoldenResponse = {
  endpoint: "GET /store/products",
  expected_status: 200,
  expected_schema: {
    id: "string",
    count: "number",
    products: "array",
    stable: {
      status: "string",
      metadata: "ignored",
    },
  },
  ignore_fields: ["id", "metadata"],
  schema_source: "openapi+observed",
  oas_operation_id: "GetProducts",
  oas_ref: null,
  oas_version: "test",
  value_rules: [{ path: "products[].status", kind: "enum", values: ["published"] }],
  captured_at: "now",
  source_sessions: [],
};

test("generateMutants is deterministic, skips ignored fields, and emits rule/status/schema mutants", () => {
  const a = generateMutants([{ key: "goldens/products.json", golden }], {
    seed: "s",
    maxPerGolden: 50,
    maxTotal: 50,
  });
  const b = generateMutants([{ key: "goldens/products.json", golden }], {
    seed: "s",
    maxPerGolden: 50,
    maxTotal: 50,
  });
  assert.deepEqual(a, b);
  assert.ok(a.some((m) => m.operator === "enum_violation" && m.path === "products[].status"));
  assert.ok(a.some((m) => m.operator === "status_change" && m.param === 500));
  assert.ok(a.some((m) => m.operator === "empty_array" && m.path === "products"));
  assert.equal(a.some((m) => m.path === "id"), false);
  assert.equal(a.some((m) => m.path === "stable.metadata"), false);
});
