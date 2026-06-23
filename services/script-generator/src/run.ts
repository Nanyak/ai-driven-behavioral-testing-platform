#!/usr/bin/env node
// Routing is two orthogonal axes. Persona picks the TOP folder
// (guest_shopper -> guest/, registered_customer -> customer/, admin_operator ->
// admin/); `attributes.has_errors` picks the SUBfolder (true -> failure-path/,
// false -> happy-path/). So every spec lands at
// `generated-tests/<persona>/<happy-path|failure-path>/<hash>.spec.ts`.
// There is no `edge` persona and no `edge/` folder — error flows live in their
// own persona's failure-path/.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAugmentedSpecs } from "../../golden/src/oas-source.js";
import type { OasDocument } from "../../golden/src/oas-types.js";
import { dedup } from "./dedup.js";
import { emitSpec } from "./emit.js";
import { loadCandidates, type Candidate } from "./load.js";
import { buildFlowPlan, type OasSpecs } from "./resolve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolvePath(__dirname, "..");
const REPO_ROOT = resolvePath(SERVICE_ROOT, "..", "..");
const GENERATED_TESTS_DIR = resolvePath(REPO_ROOT, "generated-tests");
const GOLDEN_VENDOR_DIR = resolvePath(GENERATED_TESTS_DIR, "_golden");
const GOLDEN_SOURCE_DIR = resolvePath(REPO_ROOT, "services", "golden", "src");

type PersonaFolder = "guest" | "customer" | "admin";
type PathFolder = "happy-path" | "failure-path";
const PERSONA_FOLDERS: PersonaFolder[] = ["guest", "customer", "admin"];
const PATH_FOLDERS: PathFolder[] = ["happy-path", "failure-path"];

interface Route {
  persona: PersonaFolder;
  path: PathFolder;
}

function personaFolderFor(candidate: Candidate): PersonaFolder {
  switch (candidate.persona) {
    case "guest_shopper":
      return "guest";
    case "registered_customer":
      return "customer";
    case "admin_operator":
      return "admin";
  }
}

function routeFor(candidate: Candidate): Route {
  return {
    persona: personaFolderFor(candidate),
    path: candidate.attributes.has_errors ? "failure-path" : "happy-path",
  };
}

function shortHash(signature: string): string {
  return signature.slice(0, 12);
}

// Vendor services/golden/src/ into generated-tests/_golden/ so generated-tests/
// is self-contained and never reaches back into services/ at test-run time.
function vendorGoldenComparator(): void {
  if (existsSync(GOLDEN_VENDOR_DIR)) {
    rmSync(GOLDEN_VENDOR_DIR, { recursive: true, force: true });
  }
  mkdirSync(GOLDEN_VENDOR_DIR, { recursive: true });
  cpSync(GOLDEN_SOURCE_DIR, GOLDEN_VENDOR_DIR, { recursive: true });

  // compare.ts exports compareResponse(golden, status, body), not assertGolden.
  // golden-responses/ is empty (bodies-off logs yield 0 goldens, ADR 0001) so
  // this MUST no-op gracefully when no golden file exists for an endpoint+status,
  // never throw.
  const assertGoldenSource = `/**
 * assertGolden — a thin Playwright-test wrapper around compareResponse()
 * (vendored from services/golden/src/compare.ts; see ADR 0001).
 *
 * golden-responses/ is populated only once Phase 6 ingestion + Phase 8 golden
 * generation has run end-to-end against a live, bodies-on backend; on a clean
 * checkout it is EMPTY (bodies-off logs yield 0 goldens, by design). When no
 * golden exists for (endpoint, status), this helper is a deliberate no-op —
 * it never throws and never fails a test. When a golden DOES exist, it loads
 * it and asserts the live response matches via compareResponse().
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compareResponse } from "./compare.js";
import type { GoldenResponse } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_RESPONSES_DIR = resolvePath(__dirname, "..", "..", "golden-responses");

let cache: GoldenResponse[] | null = null;

function loadGoldens(): GoldenResponse[] {
  if (cache) return cache;
  if (!existsSync(GOLDEN_RESPONSES_DIR)) {
    cache = [];
    return cache;
  }
  const files = readdirSync(GOLDEN_RESPONSES_DIR).filter((f) => f.endsWith(".json"));
  cache = files.map((f) => JSON.parse(readFileSync(resolvePath(GOLDEN_RESPONSES_DIR, f), "utf8")) as GoldenResponse);
  return cache;
}

/**
 * Assert a live (endpoint, status, body) against its stored golden, if one
 * exists. No-op otherwise (golden-responses/ is empty on a clean checkout).
 *
 * When a golden DOES exist, the schema diff is ATTACHED to the test info as
 * "golden-diff" (JSON) on BOTH pass and fail, BEFORE the expect — so Phase 10's
 * collect.ts can surface the diff for every golden-asserted step, not only the
 * failing ones. The expect() that follows still fails the test on a mismatch.
 */
export async function assertGolden(endpoint: string, liveStatus: number, liveBody: unknown): Promise<void> {
  const golden = loadGoldens().find((g) => g.endpoint === endpoint && g.expected_status === liveStatus);
  if (!golden) {
    return; // no golden for this (endpoint, status) yet -- skip, never fail.
  }
  const result = compareResponse(golden, liveStatus, liveBody);
  await test.info().attach("golden-diff", {
    body: JSON.stringify(result.schemaDiff),
    contentType: "application/json",
  });
  expect(result.pass, \`golden schema mismatch for \${endpoint}: \${JSON.stringify(result.schemaDiff)}\`).toBe(true);
}
`;
  writeFileSync(resolvePath(GOLDEN_VENDOR_DIR, "assert-golden.ts"), assertGoldenSource);

  const utilSource = `export function extractPath(value: unknown, path: string): string {
  const segments = path
    .replace(/\\[(\\d+)\\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      throw new Error(\`extractPath: cannot read "\${segment}" of \${String(current)} (path "\${path}")\`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== "string") {
    throw new Error(\`extractPath: resolved value at "\${path}" is not a string (got \${typeof current})\`);
  }
  return current;
}

export async function safeJson(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function safeText(response: { text: () => Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
`;
  writeFileSync(resolvePath(GOLDEN_VENDOR_DIR, "util.ts"), utilSource);
}

function writeConfigAndFixtures(): void {
  const configPath = resolvePath(GENERATED_TESTS_DIR, "playwright.config.ts");
  const configSource = `import { defineConfig } from "@playwright/test";

/**
 * One project per persona folder so the test-runner can scope a run with
 * \`--project <persona>\` and get per-persona pass/fail counts. Each persona's
 * \`testDir\` is matched recursively, so a project covers both its happy-path/
 * and failure-path/ subfolders; the runner filters by subfolder with a path
 * argument (\`test:happy\` / \`test:failure\`) rather than a project. This config is
 * GENERATED by services/script-generator (run.ts: writeConfigAndFixtures) —
 * edit it there, not by hand; a regeneration clobbers hand edits.
 *
 * Raw Playwright output (JSON + HTML) lands under \`reports/playwright/\`
 * (repo root) so reporting reads a stable, single location. The reporter
 * outputs honor PLAYWRIGHT_JSON_OUTPUT / PLAYWRIGHT_HTML_OUTPUT when the
 * runner sets them, defaulting to the same reports/playwright/ paths.
 */
export default defineConfig({
  testDir: ".",
  outputDir: "test-results/artifacts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  projects: [
    { name: "guest", testDir: "guest" },
    { name: "customer", testDir: "customer" },
    { name: "admin", testDir: "admin" },
  ],
  reporter: [
    ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT ?? "../reports/playwright/results.json" }],
    ["html", { outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT ?? "../reports/playwright/html", open: "never" }],
  ],
  use: {
    baseURL: process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000",
    extraHTTPHeaders: { "content-type": "application/json" },
  },
});
`;
  writeFileSync(configPath, configSource);

  const fixturesDir = resolvePath(GENERATED_TESTS_DIR, "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  const authFixturePath = resolvePath(fixturesDir, "auth.ts");
  const authFixtureSource = `import type { APIRequestContext } from "@playwright/test";

/**
 * Logs in fresh per call; Playwright workers each get their own token rather
 * than sharing mutable global state.
 */
export async function adminToken(request: APIRequestContext): Promise<string> {
  const email = process.env.MEDUSA_ADMIN_EMAIL ?? "admin@medusa-test.com";
  const password = process.env.MEDUSA_ADMIN_PASSWORD ?? "supersecret";
  const response = await request.post("/auth/user/emailpass", {
    data: { email, password },
  });
  if (response.status() !== 200) {
    throw new Error(\`admin login failed with status \${response.status()}\`);
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}
`;
  writeFileSync(authFixturePath, authFixtureSource);
}

interface RunSummaryEntry {
  signature: string;
  flow_name: string;
  persona: string;
  relDir: string;
  filename: string;
  fixmeCount: number;
  generationErrors: string[];
}

const REL_DIRS: string[] = PERSONA_FOLDERS.flatMap((persona) =>
  PATH_FOLDERS.map((path) => `${persona}/${path}`)
);

function main(): void {
  const args = process.argv.slice(2);
  const fileArgIndex = args.indexOf("--file");
  const explicitFile = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;

  const candidateFile = loadCandidates(explicitFile);
  const dedupResult = dedup(candidateFile.candidates);

  const specs: OasSpecs = loadAugmentedSpecs() as { store: OasDocument; admin: OasDocument };

  // Clean stale specs so a structural change (the happy-path/failure-path split,
  // a renamed flow, or a candidate that no longer routes here) never leaves an
  // orphaned spec behind. Persona folders hold ONLY generated specs (_golden/
  // and fixtures/ are siblings), so removing them wholesale is safe; the legacy
  // flat edge/ folder is dropped too.
  for (const folder of [...PERSONA_FOLDERS, "edge"]) {
    rmSync(resolvePath(GENERATED_TESTS_DIR, folder), { recursive: true, force: true });
  }
  for (const persona of PERSONA_FOLDERS) {
    for (const path of PATH_FOLDERS) {
      mkdirSync(resolvePath(GENERATED_TESTS_DIR, persona, path), { recursive: true });
    }
  }
  vendorGoldenComparator();
  writeConfigAndFixtures();

  const summary: RunSummaryEntry[] = [];
  const perFolderCount: Record<string, number> = Object.fromEntries(REL_DIRS.map((d) => [d, 0]));

  for (const candidate of dedupResult.candidates) {
    const route = routeFor(candidate);
    const relDir = `${route.persona}/${route.path}`;
    const filename = `${shortHash(candidate.signature)}.spec.ts`;
    const filePath = resolvePath(GENERATED_TESTS_DIR, route.persona, route.path, filename);

    const flowPlan = buildFlowPlan(candidate.steps, specs, candidate.attributes.requires_auth);
    const golden = route.path === "happy-path";
    const { source, fixmeCount } = emitSpec({ candidate, plan: flowPlan, golden });

    writeFileSync(filePath, source);
    perFolderCount[relDir]++;

    summary.push({
      signature: candidate.signature,
      flow_name: candidate.flow_name,
      persona: candidate.persona,
      relDir,
      filename: `${relDir}/${filename}`,
      fixmeCount,
      generationErrors: flowPlan.errors,
    });
  }

  const totalFiles = summary.length;
  const totalFixme = summary.reduce((n, s) => n + s.fixmeCount, 0);
  const totalErrors = summary.reduce((n, s) => n + s.generationErrors.length, 0);

  console.log("Phase 9 — Script Generator run summary");
  console.log(`  Candidates loaded:        ${candidateFile.candidates.length}`);
  console.log(
    `  Defensive dedup:          -${dedupResult.collapsedIdentical} identical, -${dedupResult.clusteredPrefix} prefix-clustered, -${dedupResult.cappedOut} capped`
  );
  console.log(`  Specs emitted:            ${totalFiles}`);
  for (const relDir of REL_DIRS) {
    console.log(`    ${relDir.padEnd(22)} ${perFolderCount[relDir]}`);
  }
  console.log(`  test.fixme blocks:        ${totalFixme}`);
  console.log(`  generation errors:        ${totalErrors}`);
  if (totalErrors > 0) {
    console.log("  Generation error detail:");
    for (const entry of summary) {
      if (entry.generationErrors.length > 0) {
        console.log(`    [${entry.filename}] ${entry.generationErrors.join("; ")}`);
      }
    }
  }
  console.log(`  Vendored _golden/ from:   services/golden/src/`);
  console.log(`  Output dir:               ${GENERATED_TESTS_DIR}`);
}

main();
