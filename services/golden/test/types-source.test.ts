/**
 * The code-derived oracle source: resolves @medusajs/types HTTP response types
 * into SchemaNodes. Asserts the two properties that make it better than Medusa's
 * published OpenAPI — accurate OPTIONALITY (`?`) and NULLABILITY (`| null`) —
 * plus the endpoint->type mapping. Skips gracefully if the backend workspace
 * (which ships @medusajs/types) is not installed.
 */
import { strict as assert } from "node:assert";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createTypesExtractor } from "../src/types-source/extract.js";
import { responseTypeFor } from "../src/types-source/endpoint-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolvePath(__dirname, "..", "..", "..", "apps", "medusa", "apps", "backend");

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

let ex: ReturnType<typeof createTypesExtractor> | null = null;
try {
  ex = createTypesExtractor(BACKEND);
} catch {
  console.log("  ok  (skipped: @medusajs/types not installed in apps/medusa)");
}

check("endpoint->type mapping resolves the tested ops", () => {
  assert.equal(responseTypeFor("GET", "/store/products"), "StoreProductListResponse");
  assert.equal(responseTypeFor("GET", "/store/products/{id}"), "StoreProductResponse");
  assert.equal(responseTypeFor("POST", "/store/carts"), "StoreCartResponse");
  assert.equal(responseTypeFor("GET", "/nope"), null);
});

if (ex) {
  const extractor = ex;

  check("version is the installed (runtime-matched) package version", () => {
    assert.match(extractor.version, /^\d+\.\d+\.\d+/);
  });

  check("list envelope: required pagination + array payload are asserted", () => {
    const s = extractor.resolve("StoreProductListResponse") as Record<string, unknown>;
    assert.ok(s);
    assert.equal(s.count, "number");
    assert.equal(s.limit, "number");
    assert.equal(s.offset, "number");
    assert.equal(s.products, "array"); // arrays are opaque leaves (matches observed model)
  });

  check("NULLABLE fields (`| null`) become 'ignored' — the webpage OAS mislabeled these as required", () => {
    const s = extractor.resolve("StoreProductResponse") as { product: Record<string, unknown> };
    assert.ok(s.product);
    // BaseProduct declares these `string | null` / `number | null`.
    assert.equal(s.product.subtitle, "ignored");
    assert.equal(s.product.hs_code, "ignored");
    assert.equal(s.product.height, "ignored");
    // A required, non-nullable field keeps its concrete type.
    assert.equal(s.product.id, "string");
  });

  check("OPTIONAL fields (`?`) become 'ignored'; required ones are kept", () => {
    const s = extractor.resolve("StoreCartResponse") as { cart: Record<string, unknown> };
    assert.ok(s.cart);
    assert.equal(s.cart.shipping_address, "ignored"); // optional
    assert.equal(s.cart.billing_address, "ignored"); // optional
    assert.equal(s.cart.items, "ignored"); // optional
    assert.equal(s.cart.currency_code, "string"); // required
    assert.equal(s.cart.promotions, "array"); // required array
  });

  check("an unknown type name resolves to null", () => {
    assert.equal(extractor.resolve("NotARealResponseType"), null);
  });
}

console.log(`\ntypes-source.test: ${passed} checks passed`);
