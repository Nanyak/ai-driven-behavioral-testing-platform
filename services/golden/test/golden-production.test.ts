/**
 * Runs against the REAL bundled Medusa v2 spec (openapi/base/), not a
 * hand-authored fixture. The real `StoreCart` schema has no meaningfully
 * under-specified field to tighten (`shipping_address`/`region` etc. are
 * fully `$ref`'d typed objects, not generic `"object"` leaves, and the one
 * generic-object field `metadata` is globally ignore-listed) — so "spec
 * field tightened by observation" can't be honestly demonstrated here. The
 * bodies-on case below instead demonstrates optional-field reconciliation
 * across sessions instead.
 */
import { strict as assert } from "node:assert";
import { loadAugmentedSpecs, resolveOperation } from "../src/oas/oas-source.js";
import { extractObservedSchema } from "../src/schema/schema-extract.js";
import { buildGolden, unionSchema } from "../src/schema/schema-merge.js";
import { checkOasDrift } from "../src/compare/version.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const specs = loadAugmentedSpecs();

check("bodies-off: a golden is produced with schema_source 'openapi' (oracle works without logged bodies)", () => {
  const oas = resolveOperation(specs, "POST", "/store/carts", 200);
  assert.ok(oas);
  const golden = buildGolden({
    endpoint: "POST /store/carts",
    observedStatus: 200,
    observedSchema: null,
    oas,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: [],
  });
  assert.equal(golden.schema_source, "openapi");
  assert.equal(golden.expected_status, 200);
  assert.equal(golden.oas_operation_id, "PostCarts");
  assert.equal(golden.oas_ref, "#/components/schemas/StoreCartResponse");
  assert.equal(golden.oas_version, "2.0.0");
});

check(
  "faithful flatten: REQUIRED fields are asserted with their declared type while OPTIONAL " +
    "fields (StoreCart.shipping_address / billing_address) become 'ignored' so a spec-conformant " +
    "response that omits or nulls them is not flagged as drift",
  () => {
    const oas = resolveOperation(specs, "POST", "/store/carts", 200);
    assert.ok(oas);
    const cart = (oas!.schema as { cart: Record<string, unknown> }).cart;
    // Required scalar keeps its declared type; required array stays an opaque leaf.
    assert.equal(cart.currency_code, "string");
    assert.equal(cart.promotions, "array");
    // Optional nested objects are NOT demanded — the old flatten promoted these
    // to required, the top cause of false OAS drift (2026-06-27 investigation).
    assert.equal(cart.shipping_address, "ignored");
    assert.equal(cart.billing_address, "ignored");
  }
);

check(
  "bodies-on: optional-field reconciliation across sessions — a field present in one observed " +
    "session's address but absent in another's is captured as part of the merged shape, not flagged " +
    "as a regression (StoreCartAddress.phone/company are optional in the real spec)",
  () => {
    const oas = resolveOperation(specs, "POST", "/store/carts", 200);
    assert.ok(oas);
    // StoreCart.shipping_address is OPTIONAL, so the spec oracle does not assert
    // it (faithful flatten -> "ignored"). The OBSERVED half below is what types
    // its fields, and optional-field reconciliation happens there.
    const cart = (oas!.schema as { cart: Record<string, unknown> }).cart;
    assert.equal(cart.shipping_address, "ignored");

    // Session A's observed cart includes a phone number; session B's doesn't
    // (both are valid — StoreCartAddress.required has neither field).
    const sessionABody = {
      cart: {
        id: "cart_A",
        currency_code: "usd",
        items: [{ id: "item_1" }],
        shipping_address: { city: "Copenhagen", country_code: "dk", phone: "+45-1234" },
      },
    };
    const sessionBBody = {
      cart: {
        id: "cart_B",
        currency_code: "usd",
        items: [{ id: "item_2" }],
        shipping_address: { city: "Aarhus", country_code: "dk" }, // no phone
      },
    };
    const observedA = extractObservedSchema(sessionABody, "POST /store/carts");
    const observedB = extractObservedSchema(sessionBBody, "POST /store/carts");

    const { schema: mergedObserved } = unionSchema(observedA, observedB);
    const mergedAddress = (mergedObserved as { cart: { shipping_address: Record<string, unknown> } }).cart
      .shipping_address;
    // phone survives the merge even though session B never observed it —
    // optional-field reconciliation, not a missing-field regression.
    assert.equal(mergedAddress.phone, "string");
    assert.equal(mergedAddress.city, "string");

    const golden = buildGolden({
      endpoint: "POST /store/carts",
      observedStatus: 200,
      observedSchema: mergedObserved,
      oas,
      capturedAt: "2026-06-19T00:00:00.000Z",
      sourceSessions: ["sess-A", "sess-B"],
    });
    assert.equal(golden.schema_source, "openapi+observed");
  }
);

check("happy-path expected_status is spec-sourced", () => {
  const oas = resolveOperation(specs, "GET", "/store/products", 200);
  assert.ok(oas);
  const golden = buildGolden({
    endpoint: "GET /store/products",
    observedStatus: 200,
    observedSchema: null,
    oas,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: [],
  });
  assert.equal(golden.expected_status, 200);
  assert.equal(golden.schema_source, "openapi");
});

check("an overlay-documented error step (gate 401) is spec-sourced with provenance", () => {
  const oas = resolveOperation(specs, "POST", "/store/carts", 401);
  assert.ok(oas, "expected the overlay to document 401 for POST /store/carts");
  const golden = buildGolden({
    endpoint: "POST /store/carts",
    observedStatus: 401,
    observedSchema: null,
    oas,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: [],
  });
  assert.equal(golden.schema_source, "openapi");
  assert.notEqual(golden.oas_operation_id, null);
  // On REAL data this 401 is a oneOf UNION (the base already documented 401
  // for a different trigger — see ADR 0004 #4) — there is no single
  // top-level $ref to stamp, so oas_ref is honestly null here even though
  // the golden is still fully spec-sourced (schema_source "openapi",
  // operationId populated). oas_ref is non-null only for responses with one
  // unambiguous top-level $ref (see the 200 case above/below).
  assert.equal(golden.oas_ref, null);
  assert.equal(golden.oas_version, "2.0.0");
});

check("an error step the overlay/base does NOT cover falls back to observed status/schema", () => {
  // The real base spec documents 200/400/401/404/409/422/500 for POST
  // /store/carts — 999 is a hypothetical status with genuinely no spec entry.
  const oas = resolveOperation(specs, "POST", "/store/carts", 999);
  assert.equal(oas, null);
  const golden = buildGolden({
    endpoint: "POST /store/carts",
    observedStatus: 999,
    observedSchema: { type: "string", message: "string" },
    oas,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: ["sess-edge"],
  });
  assert.equal(golden.schema_source, "observed");
  assert.equal(golden.expected_status, 999);
  assert.equal(golden.oas_operation_id, null);
});

check("spec-sourced goldens carry oas_operation_id, oas_ref, oas_version for drift detection", () => {
  const oas = resolveOperation(specs, "POST", "/store/carts", 200);
  const golden = buildGolden({
    endpoint: "POST /store/carts",
    observedStatus: 200,
    observedSchema: null,
    oas,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: [],
  });
  const drift = checkOasDrift(golden, "9.9.9");
  assert.equal(drift.drifted, true);
  const noDrift = checkOasDrift(golden, golden.oas_version!);
  assert.equal(noDrift.drifted, false);
});

console.log(`\ngolden-production.test: ${passed} checks passed`);
