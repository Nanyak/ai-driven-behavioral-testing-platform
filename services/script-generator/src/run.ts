#!/usr/bin/env node
/**
 * CLI entrypoint (plan §Location, `src/run.ts`). Loads candidates, defensively
 * re-dedupes, routes each candidate to its output folder, builds a request
 * plan per flow, renders `.spec.ts` files, vendors the golden comparator, and
 * writes the Playwright config + fixtures. Prints a run summary.
 *
 * Routing (brief §1): `attributes.has_errors === true` -> `edge/`, else by
 * persona -> guest_shopper -> guest/, registered_customer -> customer/,
 * admin_operator -> admin/. There is no `edge` persona.
 */
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

type Folder = "guest" | "customer" | "admin" | "edge";

function folderFor(candidate: Candidate): Folder {
  if (candidate.attributes.has_errors) return "edge";
  switch (candidate.persona) {
    case "guest_shopper":
      return "guest";
    case "registered_customer":
      return "customer";
    case "admin_operator":
      return "admin";
  }
}

/** Short, filesystem-safe hash truncation of the candidate signature (plan §3). */
function shortHash(signature: string): string {
  return signature.slice(0, 12);
}

/** Vendor services/golden/src/ into generated-tests/_golden/ (plan step 7 — self-contained, no reach-back). */
function vendorGoldenComparator(): void {
  if (existsSync(GOLDEN_VENDOR_DIR)) {
    rmSync(GOLDEN_VENDOR_DIR, { recursive: true, force: true });
  }
  mkdirSync(GOLDEN_VENDOR_DIR, { recursive: true });
  cpSync(GOLDEN_SOURCE_DIR, GOLDEN_VENDOR_DIR, { recursive: true });

  // assertGolden (brief §2): compare.ts exports compareResponse(golden, status, body),
  // not assertGolden. golden-responses/ is empty (bodies-off logs yield 0 goldens,
  // ADR 0001) so this MUST no-op gracefully when no golden file exists for an
  // endpoint+status, never throw.
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
import { expect } from "@playwright/test";
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

/** Assert a live (endpoint, status, body) against its stored golden, if one exists. No-op otherwise. */
export async function assertGolden(endpoint: string, liveStatus: number, liveBody: unknown): Promise<void> {
  const golden = loadGoldens().find((g) => g.endpoint === endpoint && g.expected_status === liveStatus);
  if (!golden) {
    return; // no golden for this (endpoint, status) yet -- skip, never fail.
  }
  const result = compareResponse(golden, liveStatus, liveBody);
  expect(result.pass, \`golden schema mismatch for \${endpoint}: \${JSON.stringify(result.schemaDiff)}\`).toBe(true);
}
`;
  writeFileSync(resolvePath(GOLDEN_VENDOR_DIR, "assert-golden.ts"), assertGoldenSource);

  const utilSource = `/** Small runtime helpers shared by generated specs. */

/** Read a dotted/bracketed path out of a JSON value, e.g. "products[0].variants[0].id". */
export function extractPath(value: unknown, path: string): string {
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

/** Parse a Playwright APIResponse body as JSON, returning {} for an empty/non-JSON body (error responses). */
export async function safeJson(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
`;
  writeFileSync(resolvePath(GOLDEN_VENDOR_DIR, "util.ts"), utilSource);
}

function writeConfigAndFixtures(): void {
  const configPath = resolvePath(GENERATED_TESTS_DIR, "playwright.config.ts");
  const configSource = `import { defineConfig } from "@playwright/test";

/**
 * Phase 9 generated-tests config (plan §Implementation steps #8). Base URL
 * from env, sensible timeouts, JSON + HTML reporters wired for Phase 10/11
 * consumption.
 */
export default defineConfig({
  testDir: ".",
  outputDir: "test-results/artifacts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [
    ["json", { outputFile: "test-results/results.json" }],
    ["html", { outputFolder: "test-results/html", open: "never" }],
  ],
  use: {
    baseURL: process.env.MEDUSA_BASE_URL ?? "http://localhost:9000",
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
 * Shared admin login fixture (plan §Implementation steps #4 — "admin token <-
 * shared fixture fixtures/auth.ts"). Logs in fresh per call; Playwright workers
 * each get their own token rather than sharing mutable global state.
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
  folder: Folder;
  filename: string;
  fixmeCount: number;
  generationErrors: string[];
}

function main(): void {
  const args = process.argv.slice(2);
  const fileArgIndex = args.indexOf("--file");
  const explicitFile = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;

  const candidateFile = loadCandidates(explicitFile);
  const dedupResult = dedup(candidateFile.candidates);

  const specs: OasSpecs = loadAugmentedSpecs() as { store: OasDocument; admin: OasDocument };

  for (const folder of ["guest", "customer", "admin", "edge"] as const) {
    mkdirSync(resolvePath(GENERATED_TESTS_DIR, folder), { recursive: true });
  }
  vendorGoldenComparator();
  writeConfigAndFixtures();

  const summary: RunSummaryEntry[] = [];
  const perFolderCount: Record<Folder, number> = { guest: 0, customer: 0, admin: 0, edge: 0 };

  for (const candidate of dedupResult.candidates) {
    const folder = folderFor(candidate);
    const filename = `${shortHash(candidate.signature)}.spec.ts`;
    const filePath = resolvePath(GENERATED_TESTS_DIR, folder, filename);

    const flowPlan = buildFlowPlan(candidate.steps, specs, candidate.attributes.requires_auth);
    const golden = folder !== "edge";
    const { source, fixmeCount } = emitSpec({ candidate, plan: flowPlan, folder, golden });

    writeFileSync(filePath, source);
    perFolderCount[folder]++;

    summary.push({
      signature: candidate.signature,
      flow_name: candidate.flow_name,
      persona: candidate.persona,
      folder,
      filename: `${folder}/${filename}`,
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
  for (const folder of ["guest", "customer", "admin", "edge"] as const) {
    console.log(`    ${folder.padEnd(9)} ${perFolderCount[folder]}`);
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
