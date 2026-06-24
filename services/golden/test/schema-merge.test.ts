import { strict as assert } from "node:assert";
import { buildGolden, tightenWithObserved, unionSchema } from "../src/schema/schema-merge.js";
import type { OasResolution } from "../src/oas/oas-source.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("tightenWithObserved narrows an under-specified spec leaf using observed shape", () => {
  const oas = { metadata: "object" as const, items: "array" as const, currency_code: "string" as const };
  const observed = { metadata: { foo: "string" as const }, items: { sku: "string" as const }, currency_code: "string" as const };
  const tightened = tightenWithObserved(oas, observed);
  assert.deepEqual(tightened, {
    metadata: { foo: "string" },
    items: { sku: "string" },
    currency_code: "string",
  });
});

check("tightenWithObserved keeps spec-only fields when observation lacks them", () => {
  const oas = { id: "string" as const, region_id: "string" as const };
  const observed = { id: "ignored" as const };
  const tightened = tightenWithObserved(oas, observed);
  assert.deepEqual(tightened, { id: "ignored", region_id: "string" });
});

check("unionSchema merges keys from both sides (optional-field reconciliation)", () => {
  const a = { id: "string" as const, currency_code: "string" as const };
  const b = { id: "string" as const, email: "string" as const };
  const { schema, conflicts } = unionSchema(a, b);
  assert.deepEqual(schema, { id: "string", currency_code: "string", email: "string" });
  assert.deepEqual(conflicts, []);
});

check("unionSchema records a type conflict on the same key with different leaf types", () => {
  const a = { amount: "number" as const };
  const b = { amount: "string" as const };
  const { conflicts } = unionSchema(a, b);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, "amount");
});

check("buildGolden stamps schema_source 'openapi' with bodies off (no observed schema)", () => {
  const oas: OasResolution = {
    schema: { id: "string", currency_code: "string" },
    operationId: "PostCarts",
    ref: "#/components/schemas/StoreCart",
    oasVersion: "2.0.0",
    valueRules: [],
  };
  const golden = buildGolden({
    endpoint: "POST /store/carts",
    observedStatus: 200,
    observedSchema: null,
    oas,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: [],
  });
  assert.equal(golden.schema_source, "openapi");
  assert.equal(golden.oas_operation_id, "PostCarts");
  assert.equal(golden.oas_ref, "#/components/schemas/StoreCart");
  assert.equal(golden.oas_version, "2.0.0");
});

check("buildGolden stamps 'openapi+observed' when both spec and observed data exist", () => {
  const oas: OasResolution = {
    schema: { id: "string", metadata: "object" },
    operationId: "PostCarts",
    ref: "#/components/schemas/StoreCart",
    oasVersion: "2.0.0",
    valueRules: [],
  };
  const golden = buildGolden({
    endpoint: "POST /store/carts",
    observedStatus: 200,
    observedSchema: { id: "ignored", metadata: "ignored" },
    oas,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: ["sess-1"],
  });
  assert.equal(golden.schema_source, "openapi+observed");
});

check("buildGolden falls back to 'observed' with null provenance when the spec has no entry", () => {
  const golden = buildGolden({
    endpoint: "GET /store/unmapped-endpoint",
    observedStatus: 200,
    observedSchema: { foo: "string" },
    oas: null,
    capturedAt: "2026-06-19T00:00:00.000Z",
    sourceSessions: ["sess-1"],
  });
  assert.equal(golden.schema_source, "observed");
  assert.equal(golden.oas_operation_id, null);
  assert.equal(golden.oas_ref, null);
  assert.equal(golden.oas_version, null);
});

console.log(`\nschema-merge.test: ${passed} checks passed`);
