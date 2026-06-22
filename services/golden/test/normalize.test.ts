import { strict as assert } from "node:assert";
import { normalizeBody } from "../src/normalize.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("strips global ignore-list fields from a flat body", () => {
  const result = normalizeBody({
    id: "cart_123",
    currency_code: "usd",
    created_at: "2026-01-01T00:00:00Z",
  });
  assert.deepEqual(result, { currency_code: "usd" });
});

check("strips ignore-list fields recursively in nested objects", () => {
  const result = normalizeBody({
    cart: { id: "cart_123", metadata: { foo: "bar" }, currency_code: "usd" },
  });
  assert.deepEqual(result, { cart: { currency_code: "usd" } });
});

check("leaves arrays and primitives untouched", () => {
  assert.deepEqual(normalizeBody([1, 2, 3]), [1, 2, 3]);
  assert.equal(normalizeBody("hello"), "hello");
  assert.equal(normalizeBody(null), null);
});

check("applies per-endpoint dotted-path additions", () => {
  const result = normalizeBody(
    { payment_collection: { id: "pay_col_123", status: "not_paid" } },
    "POST /store/payment-collections"
  );
  assert.deepEqual(result, { payment_collection: { status: "not_paid" } });
});

console.log(`\nnormalize.test: ${passed} checks passed`);
