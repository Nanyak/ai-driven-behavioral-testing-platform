import { strict as assert } from "node:assert";
import { compareResponse } from "../src/compare.js";
import type { GoldenResponse } from "../src/types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const baseGolden: GoldenResponse = {
  endpoint: "POST /store/carts",
  expected_status: 200,
  expected_schema: { id: "ignored", currency_code: "string", items: "array" },
  ignore_fields: ["id", "created_at", "updated_at"],
  schema_source: "openapi",
  oas_operation_id: "PostCarts",
  oas_ref: "#/components/schemas/StoreCart",
  oas_version: "2.0.0",
  captured_at: "2026-06-19T00:00:00.000Z",
  source_sessions: [],
};

check("matching response -> pass", () => {
  const result = compareResponse(baseGolden, 200, {
    id: "cart_abc123",
    currency_code: "usd",
    items: [],
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.schemaDiff, []);
});

check("changed status code -> detected as regression (short-circuits schema compare)", () => {
  const result = compareResponse(baseGolden, 500, { id: "cart_abc123" });
  assert.equal(result.pass, false);
  assert.equal(result.statusMatch, false);
  assert.equal(result.actualStatus, 500);
  assert.deepEqual(result.schemaDiff, []);
});

check("removed field -> detected as missing_field", () => {
  const result = compareResponse(baseGolden, 200, { id: "cart_abc123", currency_code: "usd" });
  assert.equal(result.pass, false);
  assert.ok(result.schemaDiff.some((d) => d.kind === "missing_field" && d.path === "items"));
});

check("new unexpected field -> detected as unexpected_field", () => {
  const result = compareResponse(baseGolden, 200, {
    id: "cart_abc123",
    currency_code: "usd",
    items: [],
    discount_code: "SUMMER10",
  });
  assert.equal(result.pass, false);
  assert.ok(result.schemaDiff.some((d) => d.kind === "unexpected_field" && d.path === "discount_code"));
});

check("type change -> detected as type_changed", () => {
  const result = compareResponse(baseGolden, 200, {
    id: "cart_abc123",
    currency_code: 42,
    items: [],
  });
  assert.equal(result.pass, false);
  assert.ok(
    result.schemaDiff.some(
      (d) => d.kind === "type_changed" && d.path === "currency_code" && d.expected === "string" && d.actual === "number"
    )
  );
});

check("dynamic fields (id/timestamps/tokens) never cause a false failure", () => {
  const result = compareResponse(baseGolden, 200, {
    id: "cart_completely_different_value",
    created_at: "2099-01-01T00:00:00Z",
    updated_at: "2099-01-01T00:00:00Z",
    currency_code: "usd",
    items: [],
  });
  assert.equal(result.pass, true);
});

console.log(`\ncompare.test: ${passed} checks passed`);
