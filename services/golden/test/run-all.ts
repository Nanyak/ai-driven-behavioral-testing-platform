/**
 * Test orchestrator: builds the augmented spec (so oas-source.test.ts and
 * everything downstream of it never run against a stale artifact), then runs
 * every `*.test.ts` file in this directory in-process. Each test file
 * self-checks with `node:assert` and throws on the first failure; an uncaught
 * throw here exits non-zero, which is what `check-phase8.mjs` gates on.
 *
 * Run: `npm test` (services/golden) or `npm run golden:test` (repo root).
 */
import { readdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAugmentedSpec } from "../openapi/build-oas.js";
import { stableStringify } from "../src/oas-source.js";
import { mkdirSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUGMENTED_DIR = resolvePath(__dirname, "..", "openapi", "augmented");

function ensureAugmentedSpec(): void {
  mkdirSync(AUGMENTED_DIR, { recursive: true });
  const { doc: store } = buildAugmentedSpec("store");
  const { doc: admin } = buildAugmentedSpec("admin");
  writeFileSync(resolvePath(AUGMENTED_DIR, "store.json"), `${stableStringify(store)}\n`, "utf8");
  writeFileSync(resolvePath(AUGMENTED_DIR, "admin.json"), `${stableStringify(admin)}\n`, "utf8");
}

async function main(): Promise<void> {
  console.log("services/golden: building augmented spec before tests...\n");
  ensureAugmentedSpec();

  const testFiles = readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();

  for (const file of testFiles) {
    console.log(`--- ${file} ---`);
    await import(resolvePath(__dirname, file));
    console.log("");
  }

  console.log(`All ${testFiles.length} test file(s) passed.`);
}

main().catch((error) => {
  console.error("\nTEST FAILURE:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
