/**
 * Regenerate the OpenAPI-sourced goldens from the code's `@medusajs/types`
 * declarations instead of Medusa's drifted published spec. Only touches goldens
 * currently `schema_source: "openapi"` that have a type mapping; observed and
 * observed-authoritative goldens are left untouched (the runtime is ahead of the
 * static types for those stateful endpoints, so live remains the better oracle).
 *
 * Run: npx tsx src/types-source/generate-goldens.ts   (from services/golden)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTypesGoldenResolver } from "./resolve.js";
import type { GoldenResponse } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
const BACKEND = resolvePath(REPO_ROOT, "apps", "medusa", "apps", "backend");
const GDIR = resolvePath(REPO_ROOT, "golden-responses");

function main() {
  const resolver = createTypesGoldenResolver(BACKEND);
  console.log(`types-source: @medusajs/types@${resolver.version}\n`);
  let converted = 0;
  let skipped = 0;
  for (const f of readdirSync(GDIR).filter((x) => x.endsWith(".json"))) {
    const path = resolvePath(GDIR, f);
    const g = JSON.parse(readFileSync(path, "utf8")) as GoldenResponse;
    if (g.schema_source !== "openapi") continue; // leave observed / observed-authoritative
    const [method, ...rest] = g.endpoint.split(" ");
    const endpoint = rest.join(" ");
    const next = resolver.build(method, endpoint, g.expected_status, g.ignore_fields);
    if (!next) {
      console.log(`  skip (no type mapping): ${g.endpoint} ${g.expected_status}`);
      skipped++;
      continue;
    }
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`  ${g.endpoint} -> ${next.oas_ref}`);
    converted++;
  }
  console.log(`\nconverted ${converted} golden(s) to schema_source "types"; left ${skipped} openapi golden(s) without a type mapping`);
}

main();
