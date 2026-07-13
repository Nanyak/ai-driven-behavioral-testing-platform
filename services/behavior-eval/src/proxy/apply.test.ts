import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mutant } from "../types.js";
import { applyMutation } from "./apply.js";

function mutant(partial: Partial<Mutant>): Mutant {
  return {
    id: "m",
    endpoint: "GET /store/products",
    status: 200,
    operator: "drop_field",
    path: "products[].status",
    origin_golden: "goldens/products.json",
    ...partial,
  };
}

test("drop_field applies through [] array paths", () => {
  const body = { products: [{ status: "published", title: "A" }] };
  const result = applyMutation(mutant({ operator: "drop_field" }), body, 200);
  assert.equal(result.applied, true);
  assert.deepEqual(result.body, { products: [{ title: "A" }] });
  assert.deepEqual(body, { products: [{ status: "published", title: "A" }] });
});

test("value and status operators mutate independently", () => {
  const enumResult = applyMutation(
    mutant({ operator: "enum_violation", param: "bad" }),
    { products: [{ status: "published" }] },
    200
  );
  assert.equal(enumResult.applied, true);
  assert.deepEqual(enumResult.body, { products: [{ status: "bad" }] });

  const statusResult = applyMutation(mutant({ operator: "status_change", path: null, param: 500 }), {}, 200);
  assert.equal(statusResult.applied, true);
  assert.equal(statusResult.status, 500);
});

test("absent paths are no-op and not applied", () => {
  const result = applyMutation(mutant({ path: "products[].missing" }), { products: [{}] }, 200);
  assert.equal(result.applied, false);
  assert.deepEqual(result.body, { products: [{}] });
});
