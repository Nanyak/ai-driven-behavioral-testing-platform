/**
 * Tier A value-level golden (ADR 0001) — extraction, ignore-filtering,
 * evaluation, and the compareResponse integration. Synthetic OAS docs keep the
 * unit assertions independent of Medusa-spec internals; one assertion at the
 * end resolves the REAL augmented spec to prove extraction is wired to reality.
 */
import { strict as assert } from "node:assert";
import {
  extractValueRules,
  filterIgnoredValueRules,
  evaluateValueRules,
} from "../src/value/value-rules.js";
import { compareResponse } from "../src/compare/compare.js";
import { loadAugmentedSpecs, resolveOperation } from "../src/oas/oas-source.js";
import type { OasDocument, OasSchema } from "../src/oas/oas-types.js";
import type { GoldenResponse, ValueRule } from "../src/types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function doc(schemas: Record<string, OasSchema>): OasDocument {
  return {
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: {},
    components: { schemas: schemas as OasDocument["components"]["schemas"] },
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

check("extracts enum/const/range/format constraints at the right paths", () => {
  const root: OasSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["draft", "published"] },
      kind: { type: "string", const: "order" },
      quantity: { type: "number", minimum: 1, maximum: 99 },
      email: { type: "string", format: "email" },
    },
  };
  const rules = extractValueRules(doc({}), root);
  assert.deepEqual(
    rules.find((r) => r.path === "status"),
    { path: "status", kind: "enum", values: ["draft", "published"] }
  );
  assert.deepEqual(
    rules.find((r) => r.path === "kind"),
    { path: "kind", kind: "const", value: "order" }
  );
  assert.deepEqual(
    rules.find((r) => r.path === "quantity"),
    { path: "quantity", kind: "range", min: 1, max: 99 }
  );
  assert.deepEqual(
    rules.find((r) => r.path === "email"),
    { path: "email", kind: "format", format: "email" }
  );
});

check("descends arrays with a [] path segment and resolves $ref", () => {
  const d = doc({
    Item: { type: "object", properties: { state: { type: "string", enum: ["a", "b"] } } },
  });
  const root: OasSchema = {
    type: "object",
    properties: { items: { type: "array", items: { $ref: "#/components/schemas/Item" } } },
  };
  const rules = extractValueRules(d, root);
  assert.deepEqual(rules, [{ path: "items[].state", kind: "enum", values: ["a", "b"] }]);
});

check("descends allOf branches but SKIPS oneOf alternatives (soundness)", () => {
  const allOfRoot: OasSchema = {
    allOf: [
      { type: "object", properties: { a: { type: "string", enum: ["x"] } } },
      { type: "object", properties: { b: { type: "string", const: "y" } } },
    ],
  };
  assert.equal(extractValueRules(doc({}), allOfRoot).length, 2);

  const oneOfRoot: OasSchema = {
    type: "object",
    properties: {
      payload: {
        oneOf: [
          { type: "object", properties: { status: { type: "string", enum: ["only-here"] } } },
          { type: "object", properties: { other: { type: "string" } } },
        ],
      },
    },
  };
  assert.deepEqual(extractValueRules(doc({}), oneOfRoot), []);
});

check("guards recursive $ref cycles (no infinite loop)", () => {
  const d = doc({
    Node: {
      type: "object",
      properties: {
        tag: { type: "string", enum: ["n"] },
        child: { $ref: "#/components/schemas/Node" },
      },
    },
  });
  const rules = extractValueRules(d, { $ref: "#/components/schemas/Node" });
  // Recurses a bounded number of levels, never hangs; the top-level tag is captured.
  assert.ok(rules.some((r) => r.path === "tag"));
  assert.ok(rules.length >= 1);
});

check("drops a (path,kind) reached via conflicting branches", () => {
  // Two allOf branches assert different enums for the SAME path -> unsound -> drop.
  const root: OasSchema = {
    allOf: [
      { type: "object", properties: { s: { type: "string", enum: ["a"] } } },
      { type: "object", properties: { s: { type: "string", enum: ["b"] } } },
    ],
  };
  assert.deepEqual(extractValueRules(doc({}), root), []);
});

// ---------------------------------------------------------------------------
// Ignore filtering
// ---------------------------------------------------------------------------

check("filterIgnoredValueRules drops rules on globally-ignored fields", () => {
  const rules: ValueRule[] = [
    { path: "id", kind: "format", format: "uuid" },
    { path: "products[].created_at", kind: "format", format: "date-time" },
    { path: "products[].status", kind: "enum", values: ["published"] },
  ];
  const kept = filterIgnoredValueRules(rules, "GET /store/products");
  assert.deepEqual(kept, [{ path: "products[].status", kind: "enum", values: ["published"] }]);
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const rules: ValueRule[] = [
  { path: "status", kind: "enum", values: ["a", "b"] },
  { path: "kind", kind: "const", value: "order" },
  { path: "qty", kind: "range", min: 1, max: 10 },
  { path: "email", kind: "format", format: "email" },
  { path: "items[].state", kind: "enum", values: ["ok"] },
];

check("evaluation passes a fully-valid body", () => {
  const diffs = evaluateValueRules(rules, {
    status: "a",
    kind: "order",
    qty: 5,
    email: "x@y.com",
    items: [{ state: "ok" }, { state: "ok" }],
  });
  assert.deepEqual(diffs, []);
});

check("evaluation flags enum/const/range/format violations", () => {
  const diffs = evaluateValueRules(rules, {
    status: "z",
    kind: "refund",
    qty: 999,
    email: "not-an-email",
    items: [{ state: "ok" }, { state: "bad" }],
  });
  const kinds = diffs.map((d) => `${d.path}:${d.kind}`).sort();
  assert.deepEqual(kinds, [
    "email:format",
    "items[].state:enum",
    "kind:const",
    "qty:range",
    "status:enum",
  ]);
});

check("a rule never fires on an absent or null value (orthogonal to schema layer)", () => {
  assert.deepEqual(evaluateValueRules(rules, {}), []);
  assert.deepEqual(evaluateValueRules(rules, { status: null, qty: null, email: null }), []);
});

check("range/format skip values of the wrong JSON type (type layer's job)", () => {
  const diffs = evaluateValueRules(
    [
      { path: "qty", kind: "range", min: 1, max: 10 },
      { path: "email", kind: "format", format: "email" },
    ],
    { qty: "five", email: 42 }
  );
  assert.deepEqual(diffs, []);
});

// ---------------------------------------------------------------------------
// compareResponse integration
// ---------------------------------------------------------------------------

const valueGolden: GoldenResponse = {
  endpoint: "GET /store/products",
  expected_status: 200,
  expected_schema: { products: "array" },
  ignore_fields: [],
  schema_source: "openapi",
  oas_operation_id: "GetProducts",
  oas_ref: null,
  oas_version: "1",
  value_rules: [{ path: "products[].status", kind: "enum", values: ["published"] }],
  captured_at: "2026-06-19T00:00:00.000Z",
  source_sessions: [],
};

check("compareResponse passes when both schema and value rules hold", () => {
  const result = compareResponse(valueGolden, 200, { products: [{ status: "published" }] });
  assert.equal(result.pass, true);
  assert.deepEqual(result.valueDiff, []);
});

check("compareResponse FAILS on a value violation even when the schema matches", () => {
  const result = compareResponse(valueGolden, 200, { products: [{ status: "on_fire" }] });
  assert.equal(result.pass, false);
  assert.equal(result.schemaDiff.length, 0, "schema layer is satisfied");
  assert.equal(result.valueDiff.length, 1);
  assert.equal(result.valueDiff[0].kind, "enum");
  assert.equal(result.valueDiff[0].path, "products[].status");
});

check("compareResponse tolerates a pre-Tier-A golden with no value_rules", () => {
  const legacy = { ...valueGolden } as Partial<GoldenResponse>;
  delete legacy.value_rules;
  const result = compareResponse(legacy as GoldenResponse, 200, { products: [{ status: "anything" }] });
  assert.equal(result.pass, true);
  assert.deepEqual(result.valueDiff, []);
});

// ---------------------------------------------------------------------------
// Real-spec wiring (proves extraction runs against the committed Medusa spec)
// ---------------------------------------------------------------------------

check("the real augmented spec yields the products[].status enum rule", () => {
  const specs = loadAugmentedSpecs();
  const resolution = resolveOperation(specs, "GET", "/store/products", 200);
  assert.ok(resolution, "GET /store/products 200 resolves");
  const statusRule = resolution!.valueRules.find((r) => r.path === "products[].status");
  assert.deepEqual(statusRule, {
    path: "products[].status",
    kind: "enum",
    values: ["draft", "proposed", "published", "rejected"],
  });
});

console.log(`value-rules.test: ${passed} checks passed`);
