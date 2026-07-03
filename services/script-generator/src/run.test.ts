/**
 * Unit test for the approval-aware generator helpers (run.ts). Run:
 * `npm run test:run`. Plain assertions, no framework — mirrors the repo style.
 *
 * Covers the two safety guarantees of the regression/conflict handling:
 *   1. approved specs and every undecided draft are preserved across reruns,
 *      while explicitly discarded/superseded versions retire;
 *   2. the approved outcome is read from the HITL store so the loop can withhold a
 *      drifted candidate instead of codifying it.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAugmentedSpecs } from "../../golden/src/oas-source.js";
import { manifestEntry } from "./artifacts.js";
import { buildFlowPlan, type FlowPlan, type OasSpecs } from "./resolve.js";
import {
  approvedOutcomes,
  cleanPersonaFolderPreservingApproved,
  ensureGoldenResponses,
  shouldEmitSelectedCandidate,
  versionedSpecFilename,
} from "./run.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const SIG_APPROVED = "a".repeat(64);
const SIG_OTHER = "b".repeat(64);

const spec = (sig: string, outcome: string): string =>
  `// flow_signature: ${sig}\n// status_signature: ${outcome}\ntest("x", async () => {});\n`;

check("changed outcomes get a separate deterministic draft filename", () => {
  assert.equal(versionedSpecFilename(SIG_APPROVED, "200,200,200", false), "aaaaaaaaaaaa.spec.ts");
  const draft = versionedSpecFilename(SIG_APPROVED, "200,200,500", true);
  assert.match(draft, /^aaaaaaaaaaaa-[0-9a-f]{8}\.spec\.ts$/);
  assert.notEqual(draft, "aaaaaaaaaaaa.spec.ts");
});

// 1. approvedOutcomes reads blessed outcomes (approved only) from the HITL store.
check("approvedOutcomes reads approved status_signatures from the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const store = join(dir, "approvals.json");
  writeFileSync(
    store,
    JSON.stringify({
      entries: [
        { flow_signature: SIG_APPROVED, status: "approved", status_signature: "200,200,200" },
        { flow_signature: SIG_OTHER, status: "discarded", status_signature: "200,401" },
      ],
    })
  );
  const map = approvedOutcomes(store);
  assert.deepEqual([...(map.get(SIG_APPROVED) ?? [])], ["200,200,200"]);
  assert.equal(map.has(SIG_OTHER), false, "discarded entries are not blessed baselines");
});

check("an existing exact approved artifact is never re-emitted from a stale candidate file", () => {
  const candidate = {
    signature: SIG_APPROVED,
    steps: [
      { method: "GET", endpoint: "/store/products", expected_status: 200 },
      { method: "POST", endpoint: "/store/carts", expected_status: 200 },
    ],
  };
  const outcome = "200,200";
  const approved = new Map([[SIG_APPROVED, new Set([outcome])]]);
  assert.equal(
    shouldEmitSelectedCandidate(
      candidate,
      approved,
      new Set([`${SIG_APPROVED}:${outcome}`])
    ),
    false
  );
  assert.equal(
    shouldEmitSelectedCandidate(candidate, approved, new Set()),
    true,
    "missing approved artifact must be regenerated"
  );
});

// 2. The clean preserves both the active oracle and an undecided draft.
check("clean preserves the blessed oracle and pending draft", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const personaDir = join(dir, "customer");
  mkdirSync(join(personaDir, "happy-path"), { recursive: true });
  mkdirSync(join(personaDir, "failure-path"), { recursive: true });
  const oracle = join(personaDir, "happy-path", "aaaaaaaaaaaa.spec.ts");
  const stale = join(personaDir, "failure-path", "bbbbbbbbbbbb.spec.ts");
  writeFileSync(oracle, spec(SIG_APPROVED, "200,200,200"));
  writeFileSync(stale, spec(SIG_OTHER, "200,401"));

  const approved = new Map([[SIG_APPROVED, new Set(["200,200,200"])]]);
  const preserved = cleanPersonaFolderPreservingApproved(
    personaDir,
    approved,
    new Map()
  );

  assert.equal(preserved, 2);
  assert.equal(existsSync(oracle), true, "blessed oracle survives the regen");
  assert.equal(existsSync(stale), true, "undecided draft survives until review");
});

check("clean preserves an undecided draft absent from latest selected scenarios", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const personaDir = join(dir, "customer");
  mkdirSync(join(personaDir, "failure-path"), { recursive: true });
  const stale = join(personaDir, "failure-path", "bbbbbbbbbbbb.spec.ts");
  writeFileSync(stale, spec(SIG_OTHER, "200,401"));

  const preserved = cleanPersonaFolderPreservingApproved(
    personaDir,
    new Map(),
    new Map()
  );
  assert.equal(preserved, 1);
  assert.equal(existsSync(stale), true, "a later mine cannot silently discard pending work");
});

check("clean removes a draft only after explicit discard", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const personaDir = join(dir, "customer");
  mkdirSync(join(personaDir, "failure-path"), { recursive: true });
  const draft = join(personaDir, "failure-path", "bbbbbbbbbbbb.spec.ts");
  writeFileSync(draft, spec(SIG_OTHER, "200,401"));

  const id = `${SIG_OTHER}:200,401`;
  const preserved = cleanPersonaFolderPreservingApproved(
    personaDir,
    new Map(),
    new Map([[id, "discarded"]])
  );
  assert.equal(preserved, 0);
  assert.equal(existsSync(draft), false, "explicit discard retires the exact draft");
});

// 3. RETIREMENT: once a DIFFERENT outcome is approved for the same journey, the
//    old-outcome spec is stale and must be dropped so the new oracle can regenerate.
check("clean retires a stale oracle whose blessed outcome changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const personaDir = join(dir, "customer");
  mkdirSync(join(personaDir, "happy-path"), { recursive: true });
  const staleOracle = join(personaDir, "happy-path", "aaaaaaaaaaaa.spec.ts");
  writeFileSync(staleOracle, spec(SIG_APPROVED, "200,200,200")); // old blessed 200

  // Operator has since approved the drift: the blessed outcome is now 200,200,500.
  const approved = new Map([[SIG_APPROVED, new Set(["200,200,500"])]]);
  const decisions = new Map([[`${SIG_APPROVED}:200,200,200`, "superseded"]]);
  const preserved = cleanPersonaFolderPreservingApproved(personaDir, approved, decisions);

  assert.equal(preserved, 0, "stale oracle is not preserved");
  assert.equal(existsSync(staleOracle), false, "old-outcome spec is retired");
});

// 4. Bodies-off runs still get a real spec-sourced golden before emission.
check("ensureGoldenResponses writes an OAS golden for a documented happy path", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldens-"));
  const specs = loadAugmentedSpecs();
  mkdirSync(dir, { recursive: true });
  // A pre-migration types-sourced file is stale input, not observed evidence.
  writeFileSync(
    join(dir, "get-store-products-200.json"),
    JSON.stringify({
      endpoint: "GET /store/products",
      expected_status: 200,
      expected_schema: { unexpected_legacy_field: "string" },
      ignore_fields: ["legacy"],
      schema_source: "types",
      oas_operation_id: "StoreProductListResponse",
      oas_ref: "@medusajs/types#StoreProductListResponse",
      oas_version: "2.15.5",
      value_rules: [],
      captured_at: "2026-06-26T00:00:00.000Z",
      source_sessions: [],
    })
  );
  const summary = ensureGoldenResponses(
    [
      {
        attributes: { requires_auth: false, is_admin: false, has_errors: false },
        steps: [{ method: "GET", endpoint: "/store/products", expected_status: 200 }],
      },
    ],
    specs,
    dir,
    "2026-06-27T00:00:00.000Z"
  );
  assert.equal(summary.written, 1);
  const golden = JSON.parse(readFileSync(join(dir, "get-store-products-200.json"), "utf8"));
  assert.equal(golden.endpoint, "GET /store/products");
  assert.equal(golden.expected_status, 200);
  assert.equal(golden.schema_source, "openapi");
  assert.notEqual(golden.oas_ref, null);
  assert.equal(golden.oas_version, "2.15.5");
  assert.ok(golden.expected_schema.products, "golden contains a real response schema");
  assert.equal(golden.expected_schema.unexpected_legacy_field, undefined);
  assert.equal(golden.oas_ref.startsWith("@medusajs/types"), false);
  rmSync(dir, { recursive: true, force: true });
});

// 5. An observed schema enriches the corrected OAS instead of bypassing it.
check("ensureGoldenResponses merges existing observed evidence into OAS", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldens-"));
  const path = join(dir, "get-store-products-200.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      endpoint: "GET /store/products",
      expected_status: 200,
      expected_schema: { products: "array", count: "number", offset: "number", limit: "number" },
      ignore_fields: [],
      schema_source: "observed",
      oas_operation_id: null,
      oas_ref: null,
      oas_version: null,
      value_rules: [],
      captured_at: "2026-06-26T00:00:00.000Z",
      source_sessions: ["session-1"],
    })
  );

  const summary = ensureGoldenResponses(
    [
      {
        attributes: { requires_auth: false, is_admin: false, has_errors: false },
        steps: [{ method: "GET", endpoint: "/store/products", expected_status: 200 }],
      },
    ],
    loadAugmentedSpecs(),
    dir,
    "2026-06-27T00:00:00.000Z"
  );
  assert.equal(summary.written, 1);
  const golden = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(golden.schema_source, "openapi+observed");
  assert.equal(golden.oas_version, "2.15.5");
  assert.deepEqual(golden.source_sessions, ["session-1"]);
  assert.equal(golden.captured_at, "2026-06-26T00:00:00.000Z");
  rmSync(dir, { recursive: true, force: true });
});

// 6. Observed evidence is the fallback when no OAS operation/status exists.
check("ensureGoldenResponses reuses observed-only fallback for an undocumented response", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldens-"));
  const path = join(dir, "get-store-not-in-oas-200.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      endpoint: "GET /store/not-in-oas",
      expected_status: 200,
      expected_schema: { ok: "boolean" },
      ignore_fields: [],
      schema_source: "observed",
      oas_operation_id: null,
      oas_ref: null,
      oas_version: null,
      value_rules: [],
      captured_at: "2026-06-26T00:00:00.000Z",
      source_sessions: ["session-1"],
    })
  );

  const summary = ensureGoldenResponses(
    [
      {
        attributes: { requires_auth: false, is_admin: false, has_errors: false },
        steps: [{ method: "GET", endpoint: "/store/not-in-oas", expected_status: 200 }],
      },
    ],
    loadAugmentedSpecs(),
    dir
  );
  assert.deepEqual(summary, { written: 0, reusedObserved: 1 });
  const golden = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(golden.schema_source, "observed");
  rmSync(dir, { recursive: true, force: true });
});

// 7. An undocumented/unobserved happy response cannot degrade to status-only.
check("ensureGoldenResponses fails closed when no schema source exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "goldens-"));
  const specs = loadAugmentedSpecs();
  assert.throws(
    () =>
      ensureGoldenResponses(
        [
          {
            attributes: { requires_auth: false, is_admin: false, has_errors: false },
            steps: [{ method: "GET", endpoint: "/store/not-a-real-operation", expected_status: 200 }],
          },
        ],
        specs,
        dir
      ),
    /Cannot generate happy-path tests without golden schemas/
  );
  assert.equal(existsSync(join(dir, "get-store-not-a-real-operation-200.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

check("artifact manifest hashes a redacted body plan and exact source", () => {
  const plan: FlowPlan = {
    steps: [
      {
        step: {
          method: "POST",
          endpoint: "/store/customers",
          expected_status: 200,
          request_payload: { email: "person@example.com", password: "secret", first_name: "Ada" },
        },
        resolveCalls: [],
        path: { template: "/store/customers", params: [] },
        query: {},
        body: {
          kind: "observed",
          payload: { email: "person@example.com", password: "secret", first_name: "Ada" },
        },
        auth: "publishable-key",
        captures: {},
      },
    ],
    errors: [],
  };
  const entry = manifestEntry(SIG_APPROVED, "customer/happy-path/a.spec.ts", "exact source", plan);
  const payload = (entry.body_plan.steps[0].body as { kind: "observed"; payload: Record<string, unknown> }).payload;
  assert.equal(payload.email, "<redacted>");
  assert.equal(payload.password, "<redacted>");
  assert.equal(payload.first_name, "<redacted>");
  assert.deepEqual(entry.body_rule_sources, ["observed"]);
  assert.equal(entry.generated_spec_hash.length, 64);
  assert.equal(entry.body_plan_hash.length, 64);
});

check("typical optionals use masked presence without consuming masked values or shapes", () => {
  const specs = {
    store: {
      openapi: "3.0.0",
      info: { title: "test", version: "1" },
      paths: {
        "/demo": {
          post: {
            operationId: "demo",
            responses: {},
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["title"],
                    properties: {
                      title: { type: "string" },
                      status: { type: "string", enum: ["published", "draft"] },
                      metadata: {
                        type: "object",
                        required: ["label"],
                        properties: { label: { type: "string" } },
                      },
                      rare: { type: "string" },
                      email: { type: "string" },
                      shipping_address: {
                        $ref: "#/components/schemas/CustomAddressInput",
                      },
                      access_token: { type: "string" },
                      unsupported_masked_scalar: { type: "null" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          CustomAddressInput: {
            type: "object",
            required: ["address_1", "city", "country_code"],
            properties: {
              address_1: { type: "string" },
              city: { type: "string" },
              country_code: { type: "string" },
            },
          },
        },
      },
    },
    admin: {
      openapi: "3.0.0",
      info: { title: "test", version: "1" },
      paths: {},
      components: { schemas: {} },
    },
  } as unknown as OasSpecs;
  const evidence = {
    sample_count: 5,
    body_present_count: 5,
    shape_count: 2,
    fields: [
      { path: "$.status", present_count: 5, presence_rate: 1, masked: false, primitive_types: ["string"], safe_hints: [{ type: "string", hint: "published", count: 5 }] },
      { path: "$.metadata", present_count: 4, presence_rate: 0.8, masked: true, primitive_types: ["string"], safe_hints: [{ type: "string", hint: "[masked]", count: 4 }] },
      { path: "$.rare", present_count: 3, presence_rate: 0.6, masked: false, primitive_types: ["string"], safe_hints: [] },
      { path: "$.email", present_count: 5, presence_rate: 1, masked: true, primitive_types: ["string"], safe_hints: [{ type: "string", hint: "captured@example.com", count: 5 }] },
      { path: "$.shipping_address", present_count: 5, presence_rate: 1, masked: true, primitive_types: ["object"], safe_hints: [] },
      { path: "$.shipping_address.address_1", present_count: 5, presence_rate: 1, masked: true, primitive_types: ["string"], safe_hints: [] },
      { path: "$.shipping_address.city", present_count: 5, presence_rate: 1, masked: true, primitive_types: ["string"], safe_hints: [] },
      { path: "$.shipping_address.country_code", present_count: 5, presence_rate: 1, masked: true, primitive_types: ["string"], safe_hints: [] },
      { path: "$.access_token", present_count: 5, presence_rate: 1, masked: true, primitive_types: ["string"], safe_hints: [{ type: "string", hint: "must-not-be-replayed", count: 5 }] },
      { path: "$.unsupported_masked_scalar", present_count: 5, presence_rate: 1, masked: true, primitive_types: ["string"], safe_hints: [{ type: "string", hint: "must-not-be-replayed", count: 5 }] },
    ],
  };
  const plan = buildFlowPlan(
    [{ method: "POST", endpoint: "/demo", expected_status: 200, request_body_evidence: evidence }],
    specs,
    false
  );
  const body = plan.steps[0].body;
  assert.equal(body.kind, "synthesized");
  if (body.kind !== "synthesized") return;
  assert.deepEqual(Object.keys(body.fields), ["title", "status", "metadata", "email", "shipping_address"]);
  assert.equal(body.fields.status.kind, "raw");
  assert.equal(body.fields.status.kind === "raw" ? body.fields.status.expr : "", '"published"');
  assert.equal(
    body.fields.metadata.kind === "raw" ? body.fields.metadata.expr : "",
    '{ "label": "test-label" }',
    "masked object presence selects the field, but its OAS supplies the shape"
  );
  assert.equal(
    body.fields.email.kind === "raw" ? body.fields.email.expr : "",
    '"generated-test@example.com"',
    "masked scalar hints are ignored in favor of an OAS-derived placeholder"
  );
  assert.equal(
    body.fields.shipping_address.kind === "raw" ? body.fields.shipping_address.expr : "",
    '{ "address_1": "1 Test Street", "city": "Test City", "country_code": scope.regionCountry }',
    "masked address presence selects the field; country_code derives from the live region (regionCountry), other values from OAS/fixtures"
  );
  assert.equal(
    "access_token" in body.fields,
    false,
    "masked credential presence cannot invent or replay a token"
  );
  assert.equal(
    "unsupported_masked_scalar" in body.fields,
    false,
    "masked presence cannot make an unsupported scalar schema safely synthesizable"
  );
  assert.equal(body.source, "observed");
  assert.deepEqual(body.observed_optional_fields, ["$.status", "$.metadata", "$.email", "$.shipping_address"]);
});

console.log(`\nrun.test: ${passed} checks passed`);
