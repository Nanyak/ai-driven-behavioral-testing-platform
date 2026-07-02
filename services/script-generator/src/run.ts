#!/usr/bin/env node
// Routing is two orthogonal axes. Persona picks the TOP folder
// (guest_shopper -> guest/, registered_customer -> customer/, admin_operator ->
// admin/); `attributes.has_errors` picks the SUBfolder (true -> failure-path/,
// false -> happy-path/). So every spec lands at
// `generated-tests/<persona>/<happy-path|failure-path>/<hash>.spec.ts`.
// There is no `edge` persona and no `edge/` folder — error flows live in their
// own persona's failure-path/.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAugmentedSpecs, resolveOperation } from "../../golden/src/oas-source.js";
import type { OasDocument } from "../../golden/src/oas-types.js";
import { buildGolden } from "../../golden/src/schema/schema-merge.js";
import type { GoldenResponse } from "../../golden/src/types.js";
import { dedup } from "./dedup.js";
import { emitSpec } from "./emit.js";
import { loadCandidates, type Candidate } from "./load.js";
import { buildFlowPlan, type OasSpecs } from "./resolve.js";
import { mintedFailureCandidates } from "./rules/business-rules.js";
import {
  hasBlockingRepairOutcomes,
  printRepairSummary,
  runRepair,
  type EmittedSpec,
} from "./repair/repair.js";
import { loadInvariants, verifiedInvariantsByStep } from "./invariants/types.js";
import { deterministicInvariantsByStep, mergeInvariantMaps } from "./invariants/deterministic.js";
import { businessInvariantRuntimeSource } from "./invariants/templates.js";
import { manifestEntry, writeGenerationManifest, type GenerationManifestEntry } from "./artifacts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolvePath(__dirname, "..");
const REPO_ROOT = resolvePath(SERVICE_ROOT, "..", "..");
const GENERATED_TESTS_DIR = resolvePath(REPO_ROOT, "generated-tests");
const GOLDEN_VENDOR_DIR = resolvePath(GENERATED_TESTS_DIR, "_golden");
const GOLDEN_SOURCE_DIR = resolvePath(REPO_ROOT, "services", "golden", "src");
const GOLDEN_RESPONSES_DIR = resolvePath(REPO_ROOT, "golden-responses");
const HITL_STORE = resolvePath(REPO_ROOT, "data", "hitl", "approvals.json");

// Each generated spec stamps its flow_signature (ADR 0002). Same permissive
// matcher coverage.ts uses, so a cosmetic stamp change does not silently break
// approved-spec preservation.
const SIGNATURE_STAMP = /flow_signature["'\s:=]+([0-9a-f]{64})/i;
// The outcome half (`// status_signature: 200,200,401`). Lets preservation tell a
// blessed oracle from a drifted spec that shares the (status-free) signature.
const STATUS_SIGNATURE_STAMP = /status_signature["'\s:=]+([\d,]+)/i;

/**
 * APPROVED shape -> the blessed expected-status sequence(s), read straight from the
 * HITL store. The "outcome" half of an approved flow; a re-mined candidate whose
 * signature matches a key here but whose outcome is NOT in the set is a drift the
 * generator must NOT codify. Missing/malformed store -> empty (every flow is new),
 * never fatal — mirrors coverage.ts tolerance.
 */
export function approvedOutcomes(path: string = HITL_STORE): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!existsSync(path)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return out;
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [];
  for (const raw of entries as Array<Record<string, unknown>>) {
    const signature = raw.flow_signature ?? raw.signature;
    if (raw.status !== "approved" || typeof signature !== "string") continue;
    if (typeof raw.status_signature !== "string") continue;
    const sig = signature.toLowerCase();
    const set = out.get(sig) ?? new Set<string>();
    set.add(raw.status_signature);
    out.set(sig, set);
  }
  return out;
}

export function reviewDecisions(path: string = HITL_STORE): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      entries?: Array<Record<string, unknown>>;
    };
    for (const raw of parsed.entries ?? []) {
      const signature = raw.flow_signature;
      const outcome = raw.status_signature;
      const status = raw.status;
      if (
        typeof signature === "string" &&
        typeof outcome === "string" &&
        typeof status === "string"
      ) {
        out.set(
          typeof raw.review_id === "string"
            ? raw.review_id
            : `${signature.toLowerCase()}:${outcome || "unknown"}`,
          status
        );
      }
    }
  } catch {
    // malformed store -> no decisions, never fatal
  }
  return out;
}

/** The {flow_signature, status_signature} a generated spec stamped (either may be
 * null if unreadable/unstamped — an older spec predating the status stamp). */
function specStamps(file: string): { signature: string | null; outcome: string | null } {
  try {
    const text = readFileSync(file, "utf8");
    return {
      signature: SIGNATURE_STAMP.exec(text)?.[1].toLowerCase() ?? null,
      outcome: STATUS_SIGNATURE_STAMP.exec(text)?.[1] ?? null,
    };
  } catch {
    return { signature: null, outcome: null };
  }
}

export function existingGeneratedReviewIds(dir: string = GENERATED_TESTS_DIR): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const id of existingGeneratedReviewIds(full)) ids.add(id);
    } else if (entry.endsWith(".spec.ts")) {
      const { signature, outcome } = specStamps(full);
      if (signature) ids.add(`${signature}:${outcome || "unknown"}`);
    }
  }
  return ids;
}

/**
 * Selectively clean a persona folder: delete every generated spec EXCEPT a blessed
 * oracle — one whose stamped signature is approved AND whose stamped outcome is
 * still the approved one. An approved spec must survive a regen (approved flows are
 * skip-gated out of candidates and so are never re-emitted) so it keeps running and
 * goes red on drift. But once a DIFFERENT outcome is approved for the same journey
 * (a drift the operator blessed), the old-outcome spec is STALE — it is dropped here
 * so the matching candidate can regenerate the new oracle (retirement). A spec
 * predating the status stamp (outcome === null) falls back to signature-only
 * preservation. Returns how many oracles were preserved.
 */
export function cleanPersonaFolderPreservingApproved(
  folder: string,
  approvedOutcomes: Map<string, Set<string>>,
  decisions: Map<string, string> = new Map(),
  activeReviewIds: ReadonlySet<string> | null = null
): number {
  if (!existsSync(folder)) return 0;
  let preserved = 0;
  for (const entry of readdirSync(folder)) {
    const full = join(folder, entry);
    if (statSync(full).isDirectory()) {
      preserved += cleanPersonaFolderPreservingApproved(
        full,
        approvedOutcomes,
        decisions,
        activeReviewIds
      );
    } else if (entry.endsWith(".spec.ts")) {
      const { signature, outcome } = specStamps(full);
      const blessed = signature ? approvedOutcomes.get(signature) : undefined;
      const id = signature ? `${signature}:${outcome || "unknown"}` : "";
      const decision = decisions.get(id);
      // Preserve only a still-blessed oracle; outcome === null is a pre-stamp spec
      // we cannot date, so fall back to signature-level preservation.
      const isBlessedOracle = !!blessed && (outcome === null || blessed.has(outcome));
      // The latest mine is authoritative for undecided work. A pending draft is
      // retained only when it is still a selected current scenario; stale and
      // de-selected variant drafts are removed during reconciliation.
      const isPendingDraft =
        decision === undefined && (activeReviewIds === null || activeReviewIds.has(id));
      if (isBlessedOracle || isPendingDraft) {
        preserved++;
      } else {
        rmSync(full, { force: true });
      }
    }
  }
  return preserved;
}

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

/** The "outcome" half of a candidate: its ordered expected-status sequence. MUST
 * match the dashboard's `statusSignature` and the engine's outcome so a blessed
 * outcome compares equal to a re-mined one. */
function outcomeOf(candidate: Candidate): string {
  return candidate.steps.map((s) => s.expected_status).join(",");
}

export function shouldEmitSelectedCandidate(
  candidate: Pick<Candidate, "signature" | "steps">,
  approved: Map<string, Set<string>>,
  existingReviewIds: ReadonlySet<string>
): boolean {
  const outcome = candidate.steps.map((step) => step.expected_status).join(",");
  const isBlessed = approved.get(candidate.signature)?.has(outcome) ?? false;
  return !isBlessed || !existingReviewIds.has(`${candidate.signature.toLowerCase()}:${outcome}`);
}

export function versionedSpecFilename(
  signature: string,
  statusSignature: string,
  hasActiveBaseline: boolean
): string {
  const outcomeHash = createHash("sha256").update(statusSignature).digest("hex").slice(0, 8);
  return `${shortHash(signature)}${hasActiveBaseline ? `-${outcomeHash}` : ""}.spec.ts`;
}

function goldenResponseFileName(endpoint: string, status: number): string {
  const slug = `${endpoint}-${status}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}.json`;
}

function readExistingGolden(path: string): GoldenResponse | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GoldenResponse>;
    if (
      typeof value.endpoint !== "string" ||
      typeof value.expected_status !== "number" ||
      value.expected_schema === undefined
    ) {
      return null;
    }
    return value as GoldenResponse;
  } catch {
    return null;
  }
}

export interface GoldenSyncSummary {
  written: number;
  reusedObserved: number;
}

function hasObservedEvidence(golden: GoldenResponse | null): golden is GoldenResponse {
  return golden?.schema_source === "observed" || golden?.schema_source === "openapi+observed";
}

/**
 * Materialize the oracle before emitting happy-path specs.
 *
 * OpenAPI is authoritative when it documents the operation/status. A bodies-on
 * ingestion artifact is merged in when present; otherwise buildGolden() creates
 * a spec-only schema. For an operation absent from OpenAPI, an observed schema
 * is still valid. If neither exists, generation fails before cleaning/emitting
 * specs so a missing oracle can never silently become a status-only green test.
 */
export function ensureGoldenResponses(
  candidates: Array<Pick<Candidate, "attributes" | "steps">>,
  specs: OasSpecs,
  outputDir: string = GOLDEN_RESPONSES_DIR,
  capturedAt: string = new Date().toISOString()
): GoldenSyncSummary {
  const required = new Map<string, { endpoint: string; method: string; status: number }>();
  for (const candidate of candidates) {
    if (candidate.attributes.has_errors) continue;
    for (const step of candidate.steps) {
      const endpoint = `${step.method.toUpperCase()} ${step.endpoint}`;
      required.set(`${endpoint}::${step.expected_status}`, {
        endpoint,
        method: step.method.toUpperCase(),
        status: step.expected_status,
      });
    }
  }

  const pending: Array<{ path: string; golden: GoldenResponse }> = [];
  const missing: string[] = [];
  let reusedObserved = 0;

  for (const item of required.values()) {
    const path = resolvePath(outputDir, goldenResponseFileName(item.endpoint, item.status));
    const existing = readExistingGolden(path);

    const oas = resolveOperation(specs, item.method, item.endpoint.slice(item.method.length + 1), item.status);

    if (!oas) {
      if (hasObservedEvidence(existing)) {
        reusedObserved++;
      } else {
        missing.push(`${item.endpoint} -> ${item.status}`);
      }
      continue;
    }

    const observedSchema =
      hasObservedEvidence(existing) ? existing.expected_schema : null;
    const golden = buildGolden({
      endpoint: item.endpoint,
      observedStatus: item.status,
      observedSchema,
      oas,
      capturedAt: existing?.captured_at ?? capturedAt,
      sourceSessions: existing?.source_sessions ?? [],
    });
    pending.push({ path, golden });
  }

  if (missing.length > 0) {
    throw new Error(
      `Cannot generate happy-path tests without golden schemas:\n${missing
        .map((item) => `  - ${item}`)
        .join("\n")}\nCapture response bodies for these operations or add them to the OpenAPI specification.`
    );
  }

  mkdirSync(outputDir, { recursive: true });
  for (const { path, golden } of pending) {
    writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  }
  return { written: pending.length, reusedObserved };
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
  // The generator materializes every required happy-path golden before emitting
  // specs. The runtime helper still fails closed if files are later removed.
  const assertGoldenSource = `/**
 * assertGolden — a thin Playwright-test wrapper around compareResponse()
 * (vendored from services/golden/src/compare.ts; see ADR 0001).
 *
 * The script generator creates OpenAPI-backed goldens even when response bodies
 * were not captured. Missing files are an invalid oracle configuration and fail
 * closed instead of silently degrading a schema test into a status-only test.
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
 * Assert a live (endpoint, status, body) against its stored golden.
 *
 * When a golden DOES exist, the schema diff is ATTACHED to the test info as
 * "golden-diff" (a JSON array) on BOTH pass and fail, BEFORE the expect — so the
 * test-runner's collect.ts can surface the diff for every golden-asserted step,
 * not only the failing ones. Tier A value-level violations (ADR 0001) ride a
 * separate "golden-value-diff" attachment and are folded into the assertion
 * message so a value regression flips the test red with full detail. The
 * expect() that follows fails the test on either a schema OR a value mismatch.
 */
export async function assertGolden(endpoint: string, liveStatus: number, liveBody: unknown): Promise<void> {
  const golden = loadGoldens().find((g) => g.endpoint === endpoint && g.expected_status === liveStatus);
  if (!golden) {
    throw new Error(
      \`Missing golden schema for \${endpoint} -> \${liveStatus}. Regenerate tests before running the suite.\`
    );
  }
  const result = compareResponse(golden, liveStatus, liveBody);
  await test.info().attach("golden-diff", {
    body: JSON.stringify(result.schemaDiff),
    contentType: "application/json",
  });
  await test.info().attach("golden-value-diff", {
    body: JSON.stringify(result.valueDiff),
    contentType: "application/json",
  });
  const detail = JSON.stringify({ schemaDiff: result.schemaDiff, valueDiff: result.valueDiff });
  expect(result.pass, \`golden mismatch for \${endpoint}: \${detail}\`).toBe(true);
}
`;
  writeFileSync(resolvePath(GOLDEN_VENDOR_DIR, "assert-golden.ts"), assertGoldenSource);
  writeFileSync(resolvePath(GOLDEN_VENDOR_DIR, "business-invariants.ts"), businessInvariantRuntimeSource());

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

/**
 * Non-throwing path reader used by invariant assertions. Unlike extractPath
 * (which demands a string and throws on a missing segment), getPath returns the
 * value at \`path\` or \`undefined\` when any segment is absent — so a missing field
 * surfaces as a clean assertion failure (\`undefined\` failed the matcher) instead
 * of a thrown TypeError that would mask the regression. Supports a synthetic
 * \`.length\` segment on arrays/strings so an invariant can assert e.g.
 * "cart.items.length" > 0.
 */
export function getPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\\[(\\d+)\\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = (current as { length: number }).length;
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArgIndex = args.indexOf("--file");
  const explicitFile = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;
  // Opt-in agent escalation: after the deterministic emit, repair the specs that
  // fail to reproduce their mined status_signature (see repair/). Off by default
  // so `:generate` stays deterministic; --only <substr> scopes it to one flow.
  const repairEnabled = args.includes("--repair") || process.env.RESOLVER_AGENT === "1";
  const onlyArgIndex = args.indexOf("--only");
  const repairOnly = onlyArgIndex >= 0 ? args[onlyArgIndex + 1]?.split(",").filter(Boolean) : undefined;

  const candidateFile = loadCandidates(explicitFile);
  const approved = approvedOutcomes();
  const dedupResult = dedup(candidateFile.candidates, new Set(approved.keys()));

  const specs: OasSpecs = loadAugmentedSpecs() as { store: OasDocument; admin: OasDocument };

  // Verified behavioral invariants (data/invariants/invariants.json), proposed by
  // the AI invariant step and checked against the live known-good backend. Empty
  // artifact -> every spec is status-only, exactly as before (zero behavior change
  // when no invariants exist). Generation stays deterministic: no LLM call here.
  const invariantsArtifact = loadInvariants();
  let invariantStepCount = 0;

  // The blessed outcome(s) per approved journey — drives BOTH spec preservation
  // (a still-blessed oracle survives a regen) and conflict withholding below.
  const decisions = reviewDecisions();
  const selectedCandidates = dedupResult.candidates;
  const existingReviewIds = existingGeneratedReviewIds();
  // A stale/explicit candidate artifact can still contain an exact approved
  // outcome even though normal mining skip-gates it. Never rewrite that blessed
  // source; emit only when its executable artifact is actually missing.
  const candidatesToEmit = selectedCandidates.filter((candidate) => {
    return shouldEmitSelectedCandidate(candidate, approved, existingReviewIds);
  });
  const activeReviewIds = new Set(
    selectedCandidates.map(
      (candidate) => `${candidate.signature.toLowerCase()}:${outcomeOf(candidate) || "unknown"}`
    )
  );

  // Fail before cleaning existing specs if any emitted happy path cannot be
  // backed by either OpenAPI or an observed response schema.
  const goldenSync = ensureGoldenResponses(candidatesToEmit, specs);

  // Phase-C failure-path minting: append business-rule negatives (a guest hitting
  // a gated mutation → the gate's declared rejection). Appended AFTER goldenSync —
  // mints are failure-path and need no golden. Skip a mint that a mined candidate
  // already covers (same terminal method+endpoint+status) so no negative spec is
  // duplicated; the rest emit as fully-asserted (status + gate body) guest specs.
  const mintedFailures = mintedFailureCandidates().filter((mint) => {
    const target = mint.steps[mint.steps.length - 1];
    return !candidatesToEmit.some((existing) => {
      const last = existing.steps[existing.steps.length - 1];
      return (
        last.method === target.method &&
        last.endpoint === target.endpoint &&
        last.expected_status === target.expected_status
      );
    });
  });
  candidatesToEmit.push(...mintedFailures);

  // Clean stale specs so a structural change (the happy-path/failure-path split,
  // a renamed flow, or a candidate that no longer routes here) never leaves an
  // orphaned spec behind — but PRESERVE the blessed oracle. An approved flow is
  // skip-gated out of the candidates file, so a wholesale wipe would delete its
  // oracle and never re-emit it; selective cleaning keeps it (and keeps it running,
  // so it goes red on drift), while dropping an oracle whose blessed outcome has
  // since changed. `_golden/` and `fixtures/` are siblings of the persona folders,
  // untouched. The legacy flat `edge/` folder is dropped.
  let preservedSelected = 0;
  for (const persona of PERSONA_FOLDERS) {
    preservedSelected += cleanPersonaFolderPreservingApproved(
      resolvePath(GENERATED_TESTS_DIR, persona),
      approved,
      decisions,
      activeReviewIds
    );
  }
  rmSync(resolvePath(GENERATED_TESTS_DIR, "edge"), { recursive: true, force: true });
  for (const persona of PERSONA_FOLDERS) {
    for (const path of PATH_FOLDERS) {
      mkdirSync(resolvePath(GENERATED_TESTS_DIR, persona, path), { recursive: true });
    }
  }
  vendorGoldenComparator();
  writeConfigAndFixtures();

  const summary: RunSummaryEntry[] = [];
  const artifactEntries: GenerationManifestEntry[] = [];
  const perFolderCount: Record<string, number> = Object.fromEntries(REL_DIRS.map((d) => [d, 0]));

  for (const candidate of candidatesToEmit) {
    // A changed outcome is emitted as a quarantined, outcome-versioned draft.
    // The approved oracle remains untouched and is the only version admitted by
    // normal runner targets until the operator promotes this draft.
    const blessed = approved.get(candidate.signature);
    const drift = Boolean(blessed && !blessed.has(outcomeOf(candidate)));

    const route = routeFor(candidate);
    const relDir = `${route.persona}/${route.path}`;
    const filename = versionedSpecFilename(candidate.signature, outcomeOf(candidate), drift);
    const filePath = resolvePath(GENERATED_TESTS_DIR, route.persona, route.path, filename);

    const flowPlan = buildFlowPlan(candidate.steps, specs, candidate.attributes.requires_auth);
    const golden = route.path === "happy-path";
    const invariantsByStep = mergeInvariantMaps(
      verifiedInvariantsByStep(invariantsArtifact, candidate.signature),
      deterministicInvariantsByStep(candidate)
    );
    for (const list of invariantsByStep.values()) invariantStepCount += list.length;
    const { source, fixmeCount } = emitSpec({ candidate, plan: flowPlan, golden, invariantsByStep });

    writeFileSync(filePath, source);
    artifactEntries.push(manifestEntry(candidate.signature, `${relDir}/${filename}`, source, flowPlan));
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

  writeGenerationManifest(GENERATED_TESTS_DIR, artifactEntries);

  const totalFiles = summary.length;
  const totalFixme = summary.reduce((n, s) => n + s.fixmeCount, 0);
  const totalErrors = summary.reduce((n, s) => n + s.generationErrors.length, 0);

  console.log("Script Generator run summary");
  console.log(`  Candidates loaded:        ${candidateFile.candidates.length}`);
  console.log(
    `  Scenario selection:       -${dedupResult.collapsedIdentical} identical, -${dedupResult.clusteredPrefix} related variants, -${dedupResult.cappedOut} capped`
  );
  console.log(`  Specs emitted:            ${totalFiles}`);
  for (const relDir of REL_DIRS) {
    console.log(`    ${relDir.padEnd(22)} ${perFolderCount[relDir]}`);
  }
  console.log(`  Selected specs preserved: ${preservedSelected}`);
  console.log(
    `  Approved specs unchanged: ${selectedCandidates.length - candidatesToEmit.length}`
  );
  console.log(`  Drafted conflicts:        ${candidatesToEmit.filter((c) => {
    const blessed = approved.get(c.signature);
    return Boolean(blessed && !blessed.has(outcomeOf(c)));
  }).length}`);
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
  console.log(`  Behavioral invariants:    ${invariantStepCount} verified, rendered into specs`);
  console.log(
    `  Golden schemas:           ${goldenSync.written} OAS-backed written, ${goldenSync.reusedObserved} observed-only reused`
  );
  console.log(`  Vendored _golden/ from:   services/golden/src/`);
  console.log(`  Output dir:               ${GENERATED_TESTS_DIR}`);

  if (repairEnabled) {
    // Hand the emitted draft specs to the agent escalation. Approved
    // flows are skipped — their blessed oracle is the source of truth, never
    // auto-repaired. Runs against the live SUT, so the SUT must be up.
    const emitted: EmittedSpec[] = summary.map((s) => ({
      relPath: s.filename,
      flowName: s.flow_name,
      signature: s.signature,
      fixme: s.fixmeCount > 0,
    }));
    console.log(`\nResolver-agent repair: verifying ${emitted.length} spec(s) against the live SUT…`);
    const outcomes = await runRepair(emitted, {
      approvedSignatures: new Set(approved.keys()),
      only: repairOnly,
      specs,
    });
    printRepairSummary(outcomes);
    if (hasBlockingRepairOutcomes(outcomes)) {
      process.exitCode = 1;
    }
  }
}

// Run only when invoked directly (`tsx src/run.ts`), not when imported by a test.
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
