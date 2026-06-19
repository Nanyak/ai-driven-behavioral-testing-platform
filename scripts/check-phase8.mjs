#!/usr/bin/env node

/**
 * Phase 8 verification: Golden Response Handling
 *
 * Validates `services/golden` against the plan's acceptance bullets
 * (docs/phase-8-implementation-plan.md §"Validation / acceptance"):
 *   - tsc --noEmit is clean (hard gate),
 *   - all unit tests pass (test/run-all.ts — also rebuilds the augmented spec),
 *   - build-oas injects the gate 401 into every gated cart/payment-collection
 *     op. On the REAL bundled Medusa spec every gated op already documents a
 *     401 (Medusa's own `unauthorized` response), so this check asserts the
 *     UNION collision path (`oneOf`, never overwritten) on representative
 *     gated ops — not a plain add (ADR 0004 #4). It also asserts the gate
 *     does NOT touch GET, even where the real base spec documents a 401 on a
 *     GET cart op (gate is POST/PATCH/DELETE only).
 *   - the overlay is deterministic: two builds from the same inputs are
 *     byte-identical,
 *   - the augmented spec resolves $ref into a typed schema for
 *     POST /store/carts (-> StoreCartResponse, wrapping StoreCart) and
 *     GET /store/products (-> StoreProductListResponse).
 *
 * Reads ONLY the committed `openapi/base/` + rebuilds `openapi/augmented/`
 * from it — no network access. `npm run golden:fetch-base-oas` (manual,
 * networked) is the only path that touches the network; it is NOT invoked
 * here or by `build-oas`.
 *
 * Reads/builds service-local output; needs no running stack. Run installs
 * first if node_modules is missing:  npm run golden:install
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICE = resolve(ROOT, "services", "golden");
const AUGMENTED_DIR = resolve(SERVICE, "openapi", "augmented");
const GOLDEN_RESPONSES_DIR = resolve(ROOT, "golden-responses");

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

function main() {
  console.log("Phase 8: Golden Response Handling Check");

  if (!existsSync(resolve(SERVICE, "node_modules"))) {
    fail("services/golden dependencies installed", "run `npm run golden:install` first");
    return summary();
  }

  // [1] TypeScript compiles clean (hard gate).
  console.log("\n[1] TypeScript compile (tsc --noEmit)");
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: SERVICE, encoding: "utf8" });
  if (tsc.status === 0) ok("tsc --noEmit is clean");
  else fail("tsc --noEmit", (tsc.stdout || tsc.stderr || "").trim().split("\n").slice(0, 5).join(" | "));

  // [2] Unit tests (also rebuilds the augmented spec as a side effect).
  console.log("\n[2] Unit tests (test/run-all.ts)");
  const test = spawnSync("npm", ["test", "--silent"], { cwd: SERVICE, encoding: "utf8" });
  if (test.status === 0) ok("all services/golden unit tests pass");
  else fail("services/golden unit tests", (test.stdout || test.stderr || "").trim().split("\n").slice(-5).join(" | "));
  if (test.status !== 0) {
    console.log(test.stdout || test.stderr || "");
  }

  // [3] Augmented spec exists and documents the gate overlay correctly.
  console.log("\n[3] Augmented spec: gate overlay (ADR 0004) — REAL spec, union collision path");
  const storePath = resolve(AUGMENTED_DIR, "store.json");
  if (!existsSync(storePath)) {
    fail("augmented store spec present", `expected ${storePath}`);
    return summary();
  }
  const store = JSON.parse(readFileSync(storePath, "utf8"));

  // On the REAL Medusa spec, every gated cart/payment-collection op ALREADY
  // documents a 401 (Medusa's own `unauthorized` response). So the overlay
  // never hits the pure-add branch on real data — it always unions. Assert
  // the union shape (not overwritten) on three representative gated ops.
  const unionOps = [
    ["POST /store/carts", store.paths["/store/carts"]?.post],
    ["POST /store/payment-collections", store.paths["/store/payment-collections"]?.post],
    ["POST /store/carts/{id}/line-items", store.paths["/store/carts/{id}/line-items"]?.post],
  ];
  for (const [label, operation] of unionOps) {
    const schema = operation?.responses?.["401"]?.content?.["application/json"]?.schema;
    const isUnion = schema && Array.isArray(schema.oneOf) && schema.oneOf.length === 2;
    if (isUnion) ok(`${label} 401 collision -> oneOf union (not overwritten)`);
    else fail(`${label} 401 union`, `expected a 2-branch oneOf, got ${JSON.stringify(schema)}`);
  }

  // The gate is POST/PATCH/DELETE only — GET must be untouched, even on a
  // gate-matcher path the real base spec ALSO documents a 401 on (GET
  // /store/carts/{id}). The base's plain $ref must survive unmodified.
  const cartGet401 = store.paths["/store/carts/{id}"]?.get?.responses?.["401"];
  if (cartGet401 && cartGet401.$ref === "#/components/responses/unauthorized" && !cartGet401.content) {
    ok("GET /store/carts/{id} 401 left untouched (gate is POST/PATCH/DELETE only)");
  } else {
    fail("GET cart op untouched by gate", `expected the original $ref, got ${JSON.stringify(cartGet401)}`);
  }

  // [4] Determinism: rebuild and diff byte-for-byte.
  console.log("\n[4] Overlay determinism (byte-identical rebuild)");
  const firstBuild = readFileSync(storePath, "utf8");
  const rebuild = spawnSync("npm", ["run", "build-oas", "--silent"], { cwd: SERVICE, encoding: "utf8" });
  if (rebuild.status !== 0) {
    fail("build-oas re-run succeeds", (rebuild.stderr || rebuild.stdout || "").trim().split("\n").slice(-5).join(" | "));
  } else {
    const secondBuild = readFileSync(storePath, "utf8");
    if (firstBuild === secondBuild) ok("two builds from identical inputs are byte-identical");
    else fail("byte-identical rebuild", "augmented store.json changed between builds");
  }

  // [5] $ref resolution for the plan's named operations (real Medusa v2
  // shapes — the response itself IS a top-level $ref to the wrapper, not an
  // inline schema embedding it, so this resolves one level deeper than the
  // old hand-authored fixture required).
  console.log("\n[5] $ref resolution for named operations (real Medusa v2 shapes)");
  const cartRef =
    store.paths["/store/carts"]?.post?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
  if (cartRef === "#/components/schemas/StoreCartResponse") {
    const wrapper = store.components.schemas.StoreCartResponse;
    const cartPropRef = wrapper?.properties?.cart?.$ref;
    if (cartPropRef === "#/components/schemas/StoreCart") {
      ok("POST /store/carts 200 -> StoreCartResponse -> { cart: $ref StoreCart }");
    } else {
      fail("StoreCartResponse.cart $ref", JSON.stringify(cartPropRef));
    }
  } else {
    fail("POST /store/carts 200 $ref", JSON.stringify(cartRef));
  }

  const productsRef =
    store.paths["/store/products"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
  if (productsRef === "#/components/schemas/StoreProductListResponse") {
    ok("GET /store/products 200 -> StoreProductListResponse (allOf list envelope)");
  } else {
    fail("GET /store/products 200 $ref", JSON.stringify(productsRef));
  }

  // [6] Stored goldens (optional — only present once Phase 6 ingestion + Phase 8
  // golden generation has run end-to-end against a live backend).
  console.log("\n[6] Stored goldens (golden-responses/)");
  const goldens = existsSync(GOLDEN_RESPONSES_DIR)
    ? readdirSync(GOLDEN_RESPONSES_DIR).filter((f) => f.endsWith(".json"))
    : [];
  if (goldens.length > 0) ok(`${goldens.length} stored golden(s) found`);
  else ok("no stored goldens yet (oracle utilities are unit-tested directly; end-to-end generation wires in at Phase 9/11)");

  summary();
}

function summary() {
  console.log(`\n${passed + failed} checks - ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Install deps:   npm run golden:install");
    console.log("  2. Build the spec: npm run golden:build-oas");
    console.log("  3. Run tests:      npm run golden:test");
    console.log("  4. Re-run:         npm run check:phase8");
    process.exit(1);
  }
  console.log("\nAll Phase 8 checks passed.");
}

main();
