/**
 * Unit test for ignore-fields.ts. Run via `npm test` (test/run-all.ts).
 */
import { strict as assert } from "node:assert";
import { GLOBAL_IGNORE_FIELDS, ignoreFieldsFor, isGloballyIgnored } from "../src/ignore-fields.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("global ignore list matches the exact required set", () => {
  assert.deepEqual(
    [...GLOBAL_IGNORE_FIELDS].sort(),
    [
      "cart_id",
      "created_at",
      "deleted_at",
      "id",
      "metadata",
      "order_id",
      "session_id",
      "token",
      "trace_id",
      "updated_at",
    ].sort()
  );
});

check("isGloballyIgnored recognizes global fields, rejects others", () => {
  assert.equal(isGloballyIgnored("id"), true);
  assert.equal(isGloballyIgnored("token"), true);
  assert.equal(isGloballyIgnored("currency_code"), false);
});

check("ignoreFieldsFor adds per-endpoint additions on top of the global list", () => {
  const fields = ignoreFieldsFor("POST /store/payment-collections");
  assert.ok(fields.includes("id"));
  assert.ok(fields.includes("payment_collection.id"));
});

check("ignoreFieldsFor returns only the global list for an endpoint with no additions", () => {
  const fields = ignoreFieldsFor("POST /store/carts");
  assert.deepEqual([...fields].sort(), [...GLOBAL_IGNORE_FIELDS].sort());
});

console.log(`\nignore-fields.test: ${passed} checks passed`);
