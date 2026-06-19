/**
 * Unit test for openapi/build-oas.ts. Run via `npm test` (test/run-all.ts).
 *
 * Two kinds of coverage here, kept deliberately separate:
 *
 *  - REAL DATA (`buildAugmentedSpec`, reads the committed `openapi/base/`,
 *    the genuine bundled Medusa v2 spec): every one of the 16 real gated
 *    cart/payment-collection operations ALREADY documents a 401 (Medusa's
 *    own `unauthorized` response, a `text/plain` envelope), so building
 *    against real data only ever exercises the UNION collision branch —
 *    never the pure-add branch. That's the real spec's actual shape, not a
 *    test gap.
 *  - SYNTHETIC FIXTURE (`applyGateOverlay` against an in-memory doc built
 *    here): the pure-add branch (a gated operation with NO prior 401) needs
 *    a controlled fixture to stay covered at all, since the real spec never
 *    exercises it. This in-memory doc is intentionally minimal and is not
 *    read from/written to disk.
 */
import { strict as assert } from "node:assert";
import { applyGateOverlay, buildAugmentedSpec, type OverlayReport } from "../openapi/build-oas.js";
import { stableStringify } from "../src/oas-source.js";
import type { OasDocument } from "../src/oas-types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// REAL DATA: against the committed openapi/base/store.json (bundled Medusa v2).
// ---------------------------------------------------------------------------

check("[real data] injects the gate 401 into every gated cart/payment-collection operation", () => {
  const { report } = buildAugmentedSpec("store");
  const paths = report.gateInjections.map((i) => `${i.method} ${i.path}`);
  assert.ok(paths.includes("POST /store/carts"));
  assert.ok(paths.includes("POST /store/payment-collections"));
  assert.ok(paths.includes("POST /store/carts/{id}/complete"));
  assert.ok(paths.includes("POST /store/carts/{id}/line-items"));
  // The real base spec already documents a 401 on every gated op (Medusa's
  // own `unauthorized` response), so all 16 real injections are unions.
  assert.equal(report.gateInjections.length, 16);
  assert.ok(report.gateInjections.every((i) => i.status === "unioned"));
});

check("[real data] a real collision (base 401 vs gate 401) gets a oneOf union, not an overwrite", () => {
  const { doc, report } = buildAugmentedSpec("store");
  const injection = report.gateInjections.find((i) => i.path === "/store/carts/{id}/complete");
  assert.equal(injection?.status, "unioned");

  const response = doc.paths["/store/carts/{id}/complete"].post!.responses["401"];
  // After overlay, the 401 is always inlined with application/json content
  // (no longer a bare response $ref), carrying the oneOf union.
  assert.ok("content" in response, "expected an inline response, not a bare $ref");
  const schema = response.content!["application/json"].schema as { oneOf?: unknown[] };
  assert.ok(Array.isArray(schema.oneOf), "expected a oneOf union, not an overwritten schema");
  assert.equal(schema.oneOf!.length, 2);
});

check("[real data] the overlay is deterministic: building twice from the same inputs is byte-identical", () => {
  const first = buildAugmentedSpec("store");
  const second = buildAugmentedSpec("store");
  assert.equal(stableStringify(first.doc), stableStringify(second.doc));

  const firstAdmin = buildAugmentedSpec("admin");
  const secondAdmin = buildAugmentedSpec("admin");
  assert.equal(stableStringify(firstAdmin.doc), stableStringify(secondAdmin.doc));
});

check("[real data] the gate overlay does not touch operations outside the gate matchers", () => {
  const { report } = buildAugmentedSpec("store");
  const paths = report.gateInjections.map((i) => i.path);
  assert.ok(!paths.includes("/store/products"));
});

check("[real data] the gate overlay does not touch GET, even on a gate-matcher path the base 401-documents", () => {
  const { doc, report } = buildAugmentedSpec("store");
  // GET /store/carts/{id} is real-spec-documented with a 401 (auth can be
  // optional there), but GET is excluded by GATE_METHODS — must stay untouched.
  const injectedGets = report.gateInjections.filter((i) => i.method === "GET");
  assert.equal(injectedGets.length, 0);
  const original = doc.paths["/store/carts/{id}"].get!.responses["401"];
  assert.deepEqual(original, { $ref: "#/components/responses/unauthorized" });
});

// ---------------------------------------------------------------------------
// SYNTHETIC FIXTURE: in-memory doc, to keep the pure-add branch covered.
// ---------------------------------------------------------------------------

function syntheticDoc(): OasDocument {
  return {
    openapi: "3.0.0",
    info: { title: "Synthetic Fixture", version: "0.0.0-test" },
    paths: {
      "/store/carts": {
        post: {
          operationId: "PostCarts",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
            // No 401 documented at all -> pure-add branch.
          },
        },
      },
      "/store/carts/{id}/complete": {
        post: {
          operationId: "PostCartsIdComplete",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
            // Already documents 401 for a different trigger -> union branch.
            "401": {
              description: "Malformed publishable API key.",
              content: { "application/json": { schema: { type: "object", properties: { type: { type: "string" }, message: { type: "string" } }, required: ["type", "message"] } } },
            },
          },
        },
      },
      "/store/products": {
        get: {
          operationId: "GetProducts",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
    },
    components: { schemas: {} },
  };
}

check("[synthetic fixture] a fresh gated operation with no prior 401 gets one added (not unioned)", () => {
  const doc = syntheticDoc();
  const report: OverlayReport = { gateInjections: [] };
  applyGateOverlay(doc, report);

  const injection = report.gateInjections.find((i) => i.path === "/store/carts");
  assert.equal(injection?.status, "added");
  const response = doc.paths["/store/carts"].post!.responses["401"];
  assert.ok("content" in response);
  const schema = response.content!["application/json"].schema as { oneOf?: unknown[] };
  assert.equal(schema.oneOf, undefined, "pure-add must not produce a union");
});

check("[synthetic fixture] a synthetic collision (different-trigger 401) gets a oneOf union, not an overwrite", () => {
  const doc = syntheticDoc();
  const report: OverlayReport = { gateInjections: [] };
  applyGateOverlay(doc, report);

  const injection = report.gateInjections.find((i) => i.path === "/store/carts/{id}/complete");
  assert.equal(injection?.status, "unioned");
  const response = doc.paths["/store/carts/{id}/complete"].post!.responses["401"];
  assert.ok("content" in response);
  const schema = response.content!["application/json"].schema as { oneOf?: unknown[] };
  assert.ok(Array.isArray(schema.oneOf), "expected a oneOf union, not an overwritten schema");
  assert.equal(schema.oneOf!.length, 2);
});

check("[synthetic fixture] the gate overlay does not touch operations outside the gate matchers", () => {
  const doc = syntheticDoc();
  const report: OverlayReport = { gateInjections: [] };
  applyGateOverlay(doc, report);
  const paths = report.gateInjections.map((i) => i.path);
  assert.ok(!paths.includes("/store/products"));
});

console.log(`\nbuild-oas.test: ${passed} checks passed`);
