/**
 * Asserts against the static runtime-corrected Medusa 2.15.5 spec (openapi/base/, ADR 0004
 * augmented): real $ref names (`StoreCartResponse`/`StoreProductListResponse`,
 * not the old hand-authored `StoreCart` fixture name), the exact core-tag
 * `info.version` ("2.15.5"), and the real union shape on gated 401s.
 */
import { strict as assert } from "node:assert";
import { loadAugmentedSpecs, resolveOperation } from "../src/oas/oas-source.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const specs = loadAugmentedSpecs();

check("resolves POST /store/carts 200 into a typed schema with operationId + ref + version", () => {
  const resolution = resolveOperation(specs, "POST", "/store/carts", 200);
  assert.ok(resolution, "expected a resolution for POST /store/carts 200");
  assert.equal(resolution!.operationId, "PostCarts");
  // Top-level response $ref is the WRAPPER (StoreCartResponse), not the
  // nested StoreCart it wraps — oas-source resolves the wrapper into a flat
  // shape but keeps provenance at the contract clause the operation documents.
  assert.equal(resolution!.ref, "#/components/schemas/StoreCartResponse");
  assert.equal(resolution!.oasVersion, "2.15.5");
  assert.equal(typeof resolution!.schema, "object");
  // The response envelope wraps StoreCart under a "cart" key (StoreCartResponse
  // = { cart: $ref StoreCart }) — nested-ref resolution must follow through it.
  const schema = resolution!.schema as { cart: Record<string, unknown> };
  // currency_code is REQUIRED -> asserted; items is OPTIONAL in StoreCart
  // (required:false) -> faithful flatten marks it "ignored" (not demanded).
  assert.equal(schema.cart.currency_code, "string");
  assert.equal(schema.cart.items, "ignored");
});

check("resolves GET /store/products 200 into a typed list-envelope schema (allOf composition)", () => {
  const resolution = resolveOperation(specs, "GET", "/store/products", 200);
  assert.ok(resolution, "expected a resolution for GET /store/products 200");
  assert.equal(resolution!.operationId, "GetProducts");
  assert.equal(resolution!.ref, "#/components/schemas/StoreProductListResponse");
  // StoreProductListResponse is `allOf [pagination fragment, products fragment]`
  // in the real spec — flatten() must merge both branches into one shape.
  const schema = resolution!.schema as Record<string, unknown>;
  assert.equal(schema.count, "number");
  assert.equal(schema.limit, "number");
  assert.equal(schema.offset, "number");
  assert.equal(schema.products, "array");
});

check("the augmented spec documents the gate 401 on POST /store/carts (real-data union)", () => {
  const resolution = resolveOperation(specs, "POST", "/store/carts", 401);
  assert.ok(resolution, "expected the overlay to have injected/unioned a 401 for POST /store/carts");
  // The static base spec already documents a JSON 401 on every gated op, so
  // this is always the union branch in real data —
  // never a fresh add. The flattened union still exposes the gate's
  // {type, message} object shape (it carries more structure than the bare
  // string leaf — see unionFlat's shape-mismatch rule).
  const schema = resolution!.schema as Record<string, unknown>;
  assert.equal(schema.type, "string");
  assert.equal(schema.message, "string");
});

check("the augmented spec documents the gate 401 on POST /store/payment-collections (real-data union)", () => {
  const resolution = resolveOperation(specs, "POST", "/store/payment-collections", 401);
  assert.ok(resolution);
  const schema = resolution!.schema as Record<string, unknown>;
  assert.equal(schema.type, "string");
  assert.equal(schema.message, "string");
});

check("a real collision (base already documents 401) is unioned, not overwritten — both fields present", () => {
  const resolution = resolveOperation(specs, "POST", "/store/carts/{id}/complete", 401);
  assert.ok(resolution, "expected a 401 resolution for the union case");
  // The shared runtime JSON error is unioned with the gate's GateUnauthorized
  // {type, message} object — both branches flatten together for comparison.
  const schema = resolution!.schema as Record<string, unknown>;
  assert.equal(schema.type, "string");
  assert.equal(schema.message, "string");
});

check("returns null for an operation/status the spec does not document", () => {
  const resolution = resolveOperation(specs, "DELETE", "/store/carts", 999);
  assert.equal(resolution, null);
});

check("resolves an ADR 0003 admin-reversal operation from the (real) admin spec", () => {
  const resolution = resolveOperation(specs, "POST", "/admin/orders/{id}/cancel", 200);
  assert.ok(resolution, "expected the admin order-cancel operation to resolve");
  assert.equal(resolution!.operationId, "PostOrdersIdCancel");
  assert.equal(resolution!.ref, "#/components/schemas/AdminOrderResponse");
  assert.equal(resolution!.oasVersion, "2.15.5");
});

console.log(`\noas-source.test: ${passed} checks passed`);
