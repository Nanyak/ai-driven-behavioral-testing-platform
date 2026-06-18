/**
 * Golden / unit test for signature.ts (PO-3). Run: `npm run test:signature`.
 *
 * Plain assertions, no test framework — mirrors the repo's dependency-light
 * style. Exits non-zero on the first failure so the check script can gate on it.
 */

import { strict as assert } from "node:assert";
import { canonicalTokens, flowSignature, type SignatureStep } from "./signature.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const s = (method: string, endpoint: string): SignatureStep => ({ method, endpoint });

// 1. Status is excluded — a 200/304 revalidation pair on the same endpoint
//    collapses to ONE token, so the two flows share a signature (PO-3).
check("consecutive identical METHOD+endpoint collapse (200/304 revalidation)", () => {
  const withRevalidate = [s("GET", "/store/regions"), s("GET", "/store/regions")];
  const single = [s("GET", "/store/regions")];
  assert.deepEqual(canonicalTokens(withRevalidate), ["GET /store/regions"]);
  assert.equal(flowSignature(withRevalidate), flowSignature(single));
});

// 2. NON-consecutive repeats are preserved (a real A B A loop is not A B).
check("non-consecutive repeats are preserved", () => {
  const loop = [s("GET", "/store/products"), s("GET", "/store/products/{id}"), s("GET", "/store/products")];
  assert.deepEqual(canonicalTokens(loop), [
    "GET /store/products",
    "GET /store/products/{id}",
    "GET /store/products",
  ]);
  assert.notEqual(flowSignature(loop), flowSignature([s("GET", "/store/products"), s("GET", "/store/products/{id}")]));
});

// 3. Method case is normalized; method is part of the token.
check("method is uppercased and part of the key", () => {
  assert.equal(flowSignature([s("post", "/store/carts")]), flowSignature([s("POST", "/store/carts")]));
  assert.notEqual(flowSignature([s("POST", "/store/carts")]), flowSignature([s("GET", "/store/carts")]));
});

// 4. Persona is never an input — there is no persona parameter; identical step
//    sequences with different (hypothetical) labels cannot diverge.
check("signature depends only on the step sequence", () => {
  const a = [s("GET", "/store/products"), s("POST", "/store/carts"), s("POST", "/store/carts/{id}/complete")];
  const b = [s("GET", "/store/products"), s("POST", "/store/carts"), s("POST", "/store/carts/{id}/complete")];
  assert.equal(flowSignature(a), flowSignature(b));
});

// 5. Golden hash — pins the exact SHA-256 over the canonical body so a cosmetic
//    change to the algorithm (which would silently re-key every signature, ADR
//    0002) is caught here. Canonical body for this flow:
//      "GET /store/products\nPOST /store/carts\n
//       POST /store/carts/{id}/line-items\nPOST /store/carts/{id}/complete"
check("golden hash is stable (locks the algorithm)", () => {
  const flow = [
    s("GET", "/store/products"),
    s("POST", "/store/carts"),
    s("POST", "/store/carts"), // consecutive dup → collapses before hashing
    s("POST", "/store/carts/{id}/line-items"),
    s("POST", "/store/carts/{id}/complete"),
  ];
  assert.equal(
    flowSignature(flow),
    "ecd378ca528038084b60a89a92c5a62f1c3bfcac18313c815d7a4280daa84196"
  );
});

console.log(`\nsignature.test: ${passed} checks passed`);
