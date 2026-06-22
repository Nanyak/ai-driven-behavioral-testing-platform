import { strict as assert } from "node:assert";
import { extractObservedSchema } from "../src/schema/schema-extract.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("classifies primitive leaf types", () => {
  assert.equal(extractObservedSchema("hello"), "string");
  assert.equal(extractObservedSchema(42), "number");
  assert.equal(extractObservedSchema(true), "boolean");
  assert.equal(extractObservedSchema(null), "null");
  assert.equal(extractObservedSchema([1, 2, 3]), "array");
});

check("walks nested objects into a field map", () => {
  const schema = extractObservedSchema({ currency_code: "usd", items: [] });
  assert.deepEqual(schema, { currency_code: "string", items: "array" });
});

check("flags global ignore-list fields as 'ignored' regardless of nesting", () => {
  const schema = extractObservedSchema({
    id: "cart_123",
    currency_code: "usd",
    created_at: "2026-01-01T00:00:00Z",
    metadata: { foo: "bar" },
  });
  assert.deepEqual(schema, {
    id: "ignored",
    currency_code: "string",
    created_at: "ignored",
    metadata: "ignored",
  });
});

check("dynamic fields (id/timestamps/tokens) never surface as a typed leaf", () => {
  const schema = extractObservedSchema({
    token: "secret-token",
    cart_id: "cart_abc",
    order_id: "order_abc",
    trace_id: "trace_abc",
    session_id: "sess_abc",
  });
  assert.deepEqual(schema, {
    token: "ignored",
    cart_id: "ignored",
    order_id: "ignored",
    trace_id: "ignored",
    session_id: "ignored",
  });
});

check("applies per-endpoint dotted-path ignore additions", () => {
  const schema = extractObservedSchema(
    { payment_collection: { id: "pay_col_123", status: "not_paid" } },
    "POST /store/payment-collections"
  );
  assert.deepEqual(schema, {
    payment_collection: { id: "ignored", status: "string" },
  });
});

console.log(`\nschema-extract.test: ${passed} checks passed`);
