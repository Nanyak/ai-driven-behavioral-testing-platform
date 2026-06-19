#!/usr/bin/env -S npx tsx
/**
 * fetch-base-oas.ts — the MANUAL, NETWORKED regeneration step for
 * `openapi/base/{store,admin}.json`.
 *
 * This is the ONLY script in `services/golden` that touches the network.
 * `build-oas.ts` (the deterministic overlay) and `check:phase8` read the
 * committed `openapi/base/*.json` only — re-run THIS script by hand whenever
 * the base spec needs to be refreshed against the live Medusa project.
 *
 * Medusa publishes its real OpenAPI 3 contract as a SPLIT spec: a root
 * `openapi.yaml` per API (Store / Admin) that `$ref`s out to many
 * `./components/schemas/*.yaml` files in the same GitHub tree. There is no
 * single-file JSON artifact to just download — it must be BUNDLED (all
 * external `$ref`s resolved and inlined into one self-contained document
 * with purely internal `#/components/...` refs) before `oas-source.ts` (a
 * single-file JSON loader, not a multi-file resolver) can read it.
 *
 * Bundling is done with `@redocly/cli bundle <root> --ext json -o <out>`,
 * pinned as a devDependency of this package (NOT invoked via unpinned
 * `npx -y`) so the bundle step is reproducible across machines/CI.
 *
 * Source roots (HTTP 200, confirmed against the `develop` branch):
 *   Store: https://raw.githubusercontent.com/medusajs/medusa/develop/www/apps/api-reference/specs/store/openapi.yaml
 *   Admin: https://raw.githubusercontent.com/medusajs/medusa/develop/www/apps/api-reference/specs/admin/openapi.yaml
 *
 * Bundled result (verified): `openapi: "3.0.0"`, `info.version: "2.0.0"` for
 * BOTH specs — Store: 63 paths / 109 schemas; Admin: 255 paths / 468 schemas.
 * Medusa's spec `info.version` is independent of the `@medusajs/medusa` npm
 * package version (2.15.5 in this repo) — see README "Base OAS" section.
 *
 * Run (network required):
 *   npx tsx openapi/fetch-base-oas.ts
 *   # or: npm run fetch-base-oas (from services/golden)
 *
 * Then re-run the OFFLINE deterministic step to re-augment from the
 * refreshed base, and re-run the test suite:
 *   npm run build-oas && npm test
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolvePath(__dirname, "base");

/** Medusa's published split-spec root documents (resolved via Redocly bundling). */
const SPEC_ROOTS = {
  store:
    "https://raw.githubusercontent.com/medusajs/medusa/develop/www/apps/api-reference/specs/store/openapi.yaml",
  admin:
    "https://raw.githubusercontent.com/medusajs/medusa/develop/www/apps/api-reference/specs/admin/openapi.yaml",
} as const;

/** The spec `info.version` confirmed in both bundled documents at authoring time. */
export const EXPECTED_OAS_VERSION = "2.0.0";

function bundle(name: keyof typeof SPEC_ROOTS): void {
  const outPath = resolvePath(BASE_DIR, `${name}.json`);
  console.log(`fetch-base-oas: bundling ${name} from ${SPEC_ROOTS[name]} ...`);
  const result = spawnSync(
    "npx",
    ["redocly", "bundle", SPEC_ROOTS[name], "--ext", "json", "-o", outPath],
    { cwd: resolvePath(__dirname, ".."), encoding: "utf8", stdio: "inherit" }
  );
  if (result.status !== 0) {
    throw new Error(`redocly bundle failed for ${name} (exit ${result.status})`);
  }

  const doc = JSON.parse(readFileSync(outPath, "utf8")) as {
    info: { version: string };
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  const pathCount = Object.keys(doc.paths).length;
  const schemaCount = Object.keys(doc.components.schemas).length;
  console.log(
    `fetch-base-oas: wrote ${outPath} (info.version=${doc.info.version}, ${pathCount} paths, ${schemaCount} schemas)`
  );
  if (doc.info.version !== EXPECTED_OAS_VERSION) {
    console.warn(
      `fetch-base-oas: WARNING — bundled ${name} info.version is "${doc.info.version}", ` +
        `expected "${EXPECTED_OAS_VERSION}" (Medusa may have cut a new spec version since this script was last updated).`
    );
  }
}

function main(): void {
  bundle("store");
  bundle("admin");
  console.log(
    "\nfetch-base-oas: done. Re-run `npm run build-oas` to re-augment from the refreshed base, then `npm test`."
  );
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
