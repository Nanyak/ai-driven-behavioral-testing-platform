/**
 * Env vars use the CANONICAL repo-wide names (root .env / .env.example,
 * services/traffic-generator/src/config/config.ts), which the generated specs +
 * fixtures/auth.ts also read. Precedence: process.env > service .env >
 * repo-root .env, mirroring config.ts, so a bare `npm run test:guest` picks up
 * the same key the rest of the stack uses.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolvePath(__dirname, "..");
const REPO_ROOT = resolvePath(SERVICE_ROOT, "..", "..");
const GENERATED_TESTS_DIR = resolvePath(REPO_ROOT, "generated-tests");
const REPORTS_DIR = resolvePath(REPO_ROOT, "reports", "playwright");
const REPO_REPORTS_DIR = resolvePath(REPO_ROOT, "reports");

export type Project = "guest" | "customer" | "admin";
// Path filters cut ACROSS personas: a positional Playwright argument matches
// the spec's file path, so `failure-path` runs every persona's failure-path/
// folder (and `happy-path` every happy-path/). They replace the old `edge`
// project, which the happy-path/failure-path split folded into each persona.
export type PathFilter = "happy" | "failure";
export type Target = Project | PathFilter | "all" | "drafts";

export const PROJECTS: Project[] = ["guest", "customer", "admin"];
export const PATH_FILTERS: PathFilter[] = ["happy", "failure"];

const PATH_FILTER_DIR: Record<PathFilter, string> = {
  happy: "happy-path",
  failure: "failure-path",
};

const HITL_STORE = resolvePath(REPO_ROOT, "data", "hitl", "approvals.json");
const ARTIFACT_MANIFEST = resolvePath(GENERATED_TESTS_DIR, ".artifacts.json");
const SIGNATURE_STAMP = /flow_signature["'\s:=]+([0-9a-f]{64})/i;

interface ApprovalEntry {
  flow_signature?: string;
  status?: string;
  spec_hash?: string;
  body_plan_hash?: string;
}

interface ArtifactEntry {
  flow_signature?: string;
  body_plan_hash?: string;
  body_plan?: unknown;
}

export function effectiveBodyPlanHash(source: string, sourceHash: string, manifest?: ArtifactEntry): string | undefined {
  if (source.includes("// repaired-by: resolver-agent") && manifest?.body_plan !== undefined) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          baseline: manifest.body_plan,
          agent_repair: {
            source_hash: sourceHash,
            authority: "Complete Playwright source is authoritative for repaired request construction.",
          },
        })
      )
      .digest("hex");
  }
  return manifest?.body_plan_hash;
}

export function exactApprovalMatches(
  sourceHash: string,
  bodyPlanHash: string | undefined,
  decision?: ApprovalEntry
): boolean {
  return Boolean(
    decision?.status === "approved" &&
      typeof decision.spec_hash === "string" &&
      decision.spec_hash === sourceHash &&
      typeof decision.body_plan_hash === "string" &&
      decision.body_plan_hash === bodyPlanHash
  );
}

function jsonEntries<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: T[] } | T[];
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function listSpecFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSpecFiles(full));
    else if (entry.endsWith(".spec.ts")) files.push(full);
  }
  return files;
}

function relativeSpecPath(path: string): string {
  return path.slice(GENERATED_TESTS_DIR.length + 1).split(sep).join("/");
}

function targetMatches(path: string, target: Target): boolean {
  if (target === "all" || target === "drafts") return true;
  if (target === "happy" || target === "failure") return path.includes(`/${PATH_FILTER_DIR[target]}/`);
  return path.startsWith(`${target}/`);
}

/**
 * Build the exact Playwright allowlist. Normal targets admit only artifacts whose
 * current source + body-plan hashes match an approved decision. `drafts` is the
 * explicit quarantine escape hatch and excludes discarded artifacts.
 */
export function selectedSpecPaths(target: Target): string[] {
  const approvals = new Map(
    jsonEntries<ApprovalEntry>(HITL_STORE)
      .filter((entry) => typeof entry.flow_signature === "string")
      .map((entry) => [entry.flow_signature!.toLowerCase(), entry])
  );
  const bodyPlans = new Map(
    jsonEntries<ArtifactEntry>(ARTIFACT_MANIFEST)
      .filter((entry) => typeof entry.flow_signature === "string")
      .map((entry) => [entry.flow_signature!.toLowerCase(), entry])
  );

  const selected: string[] = [];
  for (const file of listSpecFiles(GENERATED_TESTS_DIR)) {
    const source = readFileSync(file, "utf8");
    const signature = SIGNATURE_STAMP.exec(source)?.[1].toLowerCase();
    if (!signature) continue;
    const decision = approvals.get(signature);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const manifest = bodyPlans.get(signature);
    const planHash = effectiveBodyPlanHash(source, sourceHash, manifest);
    const exactApproved = exactApprovalMatches(sourceHash, planHash, decision);
    const rel = relativeSpecPath(file);

    if (target === "drafts") {
      if (!exactApproved && decision?.status !== "discarded") selected.push(rel);
    } else if (exactApproved && targetMatches(rel, target)) {
      selected.push(rel);
    }
  }
  return selected.sort();
}

export interface RunOptions {
  target: Target;
  execute?: boolean;
  extraArgs?: string[];
  /**
   * Exact generated spec paths for trusted internal verification workflows.
   * This deliberately bypasses HITL admission so a quarantined draft can be
   * verified before approval. Normal suite runs must leave this undefined.
   */
  directSpecPaths?: string[];
}

export interface RunResult {
  status: number;
  jsonReportPath: string;
  htmlReportDir: string;
  stdout: string;
  stderr: string;
}

export type DirectSpecValidation =
  | { ok: true; paths: string[] }
  | { ok: false; error: string };

/**
 * Validate the narrow admission bypass used by the resolver-agent repair loop.
 * Paths must name existing generated specs inside the selected persona folder;
 * absolute paths, traversal, cross-persona paths, and non-spec files are rejected.
 */
export function validateDirectSpecPaths(
  target: Target,
  paths: string[],
  generatedTestsDir = GENERATED_TESTS_DIR
): DirectSpecValidation {
  if (!PROJECTS.includes(target as Project)) {
    return { ok: false, error: "direct spec execution requires a persona target" };
  }
  if (paths.length === 0) {
    return { ok: false, error: "direct spec execution requires at least one path" };
  }

  const validated = new Set<string>();
  for (const raw of paths) {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.includes("\\") ||
      raw.startsWith("/") ||
      raw.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      return { ok: false, error: `invalid direct spec path "${raw}"` };
    }

    const absolute = resolvePath(generatedTestsDir, raw);
    const rootPrefix = generatedTestsDir.endsWith(sep) ? generatedTestsDir : `${generatedTestsDir}${sep}`;
    if (!absolute.startsWith(rootPrefix)) {
      return { ok: false, error: `direct spec path escapes generated-tests: "${raw}"` };
    }

    const relative = absolute
      .slice(rootPrefix.length)
      .split(sep)
      .join("/");
    if (!relative.startsWith(`${target}/`) || !relative.endsWith(".spec.ts")) {
      return {
        ok: false,
        error: `direct spec path must be a ${target} .spec.ts file: "${raw}"`,
      };
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      return { ok: false, error: `direct spec path does not exist: "${raw}"` };
    }
    validated.add(relative);
  }

  return { ok: true, paths: [...validated].sort() };
}

/**
 * Remove fixed-path reporter artifacts before Playwright starts. Without this,
 * a startup/configuration failure could leave the previous run's JSON in place
 * for the CLI to normalize as if it belonged to the current run.
 */
export function clearPreviousRunArtifacts(jsonReportPath: string, htmlReportDir: string): void {
  rmSync(jsonReportPath, { force: true });
  rmSync(htmlReportDir, { recursive: true, force: true });
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    vars[key] = value;
  }
  return vars;
}

const fileEnv: Record<string, string> = {
  ...parseEnvFile(resolvePath(REPO_ROOT, ".env")),
  ...parseEnvFile(resolvePath(SERVICE_ROOT, ".env")),
};
const fromEnv = (key: string, fallback: string): string => process.env[key] ?? fileEnv[key] ?? fallback;

function runEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MEDUSA_BACKEND_URL: fromEnv("MEDUSA_BACKEND_URL", "http://localhost:9000"),
    MEDUSA_PUBLISHABLE_API_KEY: fromEnv("MEDUSA_PUBLISHABLE_API_KEY", ""),
    MEDUSA_ADMIN_EMAIL: fromEnv("MEDUSA_ADMIN_EMAIL", "admin@medusa-test.com"),
    MEDUSA_ADMIN_PASSWORD: fromEnv("MEDUSA_ADMIN_PASSWORD", "supersecret"),
    PLAYWRIGHT_JSON_OUTPUT: resolvePath(REPORTS_DIR, "results.json"),
    PLAYWRIGHT_HTML_OUTPUT: resolvePath(REPORTS_DIR, "html"),
  };
}

/**
 * Deliberately does NOT pass `--reporter`: the generated playwright.config.ts
 * already wires JSON + HTML reporters reading PLAYWRIGHT_JSON_OUTPUT /
 * PLAYWRIGHT_HTML_OUTPUT (set in runEnv()). Overriding with `--reporter json`
 * would drop the configured `outputFile` and stream JSON to stdout instead.
 */
export function buildArgs(target: Target, extraArgs: string[] = [], specPaths: string[] = []): string[] {
  const args = ["playwright", "test"];
  if (specPaths.length > 0) {
    args.push(...specPaths);
    if (target === "guest" || target === "customer" || target === "admin") {
      args.push("--project", target);
    }
  } else if (target === "happy" || target === "failure") {
    // Positional filter -> matches every persona's <happy-path|failure-path>/
    // spec path; no --project so it spans guest/customer/admin.
    args.push(PATH_FILTER_DIR[target]);
  } else if (target !== "all" && target !== "drafts") {
    args.push("--project", target);
  }
  args.push(...extraArgs);
  return args;
}

export function runPlaywright(options: RunOptions): RunResult {
  const { target, execute = true, extraArgs = [], directSpecPaths } = options;
  mkdirSync(REPORTS_DIR, { recursive: true });

  const jsonReportPath = resolvePath(REPORTS_DIR, "results.json");
  const htmlReportDir = resolvePath(REPORTS_DIR, "html");

  if (!execute) {
    return { status: 0, jsonReportPath, htmlReportDir, stdout: "", stderr: "" };
  }

  clearPreviousRunArtifacts(jsonReportPath, htmlReportDir);

  let specPaths: string[];
  if (directSpecPaths !== undefined) {
    const direct = validateDirectSpecPaths(target, directSpecPaths);
    if (!direct.ok) {
      return {
        status: 1,
        jsonReportPath,
        htmlReportDir,
        stdout: "",
        stderr: `${direct.error}\n`,
      };
    }
    specPaths = direct.paths;
  } else {
    specPaths = selectedSpecPaths(target);
  }
  if (specPaths.length === 0) {
    const mode = target === "drafts" ? "draft" : "hash-matching approved";
    return {
      status: 1,
      jsonReportPath,
      htmlReportDir,
      stdout: "",
      stderr: `No ${mode} specs matched target "${target}".\n`,
    };
  }

  const proc = spawnSync("npx", buildArgs(target, extraArgs, specPaths), {
    cwd: GENERATED_TESTS_DIR,
    encoding: "utf8",
    env: runEnv(),
  });

  return {
    status: proc.status ?? 1,
    jsonReportPath,
    htmlReportDir,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

export { GENERATED_TESTS_DIR, REPORTS_DIR, REPO_REPORTS_DIR };
