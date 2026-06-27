/**
 * Unit test for the approval-aware generator helpers (run.ts). Run:
 * `npm run test:run`. Plain assertions, no framework — mirrors the repo style.
 *
 * Covers the two safety guarantees of the regression/conflict handling:
 *   1. an approved spec is PRESERVED across the clean (the blessed oracle survives
 *      a regen and keeps running, so it goes red on drift), while non-approved
 *      specs are removed as before;
 *   2. the approved outcome is read from the HITL store so the loop can withhold a
 *      drifted candidate instead of codifying it.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAugmentedSpecs } from "../../golden/src/oas-source.js";
import {
  approvedOutcomes,
  cleanPersonaFolderPreservingApproved,
  ensureGoldenResponses,
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

// 2. The clean PRESERVES a blessed oracle and removes a non-approved one.
check("clean preserves the blessed oracle, removes the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const personaDir = join(dir, "customer");
  mkdirSync(join(personaDir, "happy-path"), { recursive: true });
  mkdirSync(join(personaDir, "failure-path"), { recursive: true });
  const oracle = join(personaDir, "happy-path", "aaaaaaaaaaaa.spec.ts");
  const stale = join(personaDir, "failure-path", "bbbbbbbbbbbb.spec.ts");
  writeFileSync(oracle, spec(SIG_APPROVED, "200,200,200"));
  writeFileSync(stale, spec(SIG_OTHER, "200,401"));

  const approved = new Map([[SIG_APPROVED, new Set(["200,200,200"])]]);
  const preserved = cleanPersonaFolderPreservingApproved(personaDir, approved);

  assert.equal(preserved, 1);
  assert.equal(existsSync(oracle), true, "blessed oracle survives the regen");
  assert.equal(existsSync(stale), false, "non-approved spec is cleaned");
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
  const preserved = cleanPersonaFolderPreservingApproved(personaDir, approved);

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

console.log(`\nrun.test: ${passed} checks passed`);
