/**
 * run.ts (Phase 10 plan step #2). Shells out to `playwright test` inside
 * generated-tests/, selecting one persona project (or all), passing base URL +
 * credentials via env, and forcing JSON + HTML reporters into
 * reports/playwright/ (plan §Location). Returns the path to the JSON report so
 * collect.ts can normalize it.
 *
 * Persona == Playwright project (Phase 9 generated playwright.config.ts):
 * `guest | customer | admin | edge`. `all` runs every project.
 *
 * Env contract (must match what the generated specs + fixtures/auth.ts read):
 *   MEDUSA_BASE_URL, MEDUSA_PUBLISHABLE_KEY,
 *   MEDUSA_ADMIN_EMAIL, MEDUSA_ADMIN_PASSWORD.
 * These are inherited from the parent process env; this module only fills in
 * sane defaults so a bare `npm run test:guest` still points at local Medusa.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolvePath(__dirname, "..");
const REPO_ROOT = resolvePath(SERVICE_ROOT, "..", "..");
const GENERATED_TESTS_DIR = resolvePath(REPO_ROOT, "generated-tests");
const REPORTS_DIR = resolvePath(REPO_ROOT, "reports", "playwright");

export type Project = "guest" | "customer" | "admin" | "edge";
export type Target = Project | "all";

export const PROJECTS: Project[] = ["guest", "customer", "admin", "edge"];

export interface RunOptions {
  target: Target;
  /** When false, build the command but do not execute it (used by --list / dry runs). */
  execute?: boolean;
  /** Extra args appended to the playwright invocation (e.g. ["--list"]). */
  extraArgs?: string[];
}

export interface RunResult {
  /** Playwright exit code (0 = all passed). */
  status: number;
  /** Absolute path to the JSON report written by the run. */
  jsonReportPath: string;
  /** Absolute path to the HTML report folder. */
  htmlReportDir: string;
  stdout: string;
  stderr: string;
}

/** Build the env the generated suite + fixtures read, layering defaults under the real env. */
function runEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MEDUSA_BASE_URL: process.env.MEDUSA_BASE_URL ?? "http://localhost:9000",
    MEDUSA_PUBLISHABLE_KEY: process.env.MEDUSA_PUBLISHABLE_KEY ?? "",
    MEDUSA_ADMIN_EMAIL: process.env.MEDUSA_ADMIN_EMAIL ?? "admin@medusa-test.com",
    MEDUSA_ADMIN_PASSWORD: process.env.MEDUSA_ADMIN_PASSWORD ?? "supersecret",
    // Force reporter output locations (the generated config honors these).
    PLAYWRIGHT_JSON_OUTPUT: resolvePath(REPORTS_DIR, "results.json"),
    PLAYWRIGHT_HTML_OUTPUT: resolvePath(REPORTS_DIR, "html"),
  };
}

/**
 * Build the playwright CLI args for a target (all => no --project filter).
 *
 * We deliberately do NOT pass `--reporter` here: the generated
 * playwright.config.ts already wires JSON + HTML reporters whose output paths
 * read PLAYWRIGHT_JSON_OUTPUT / PLAYWRIGHT_HTML_OUTPUT (set in runEnv()), so we
 * keep both files landing under reports/playwright/. Overriding with
 * `--reporter json` would drop the configured `outputFile` and stream JSON to
 * stdout instead.
 */
export function buildArgs(target: Target, extraArgs: string[] = []): string[] {
  const args = ["playwright", "test"];
  if (target !== "all") {
    args.push("--project", target);
  }
  args.push(...extraArgs);
  return args;
}

/** Run (or dry-build) a persona-scoped Playwright invocation. */
export function runPlaywright(options: RunOptions): RunResult {
  const { target, execute = true, extraArgs = [] } = options;
  mkdirSync(REPORTS_DIR, { recursive: true });

  const jsonReportPath = resolvePath(REPORTS_DIR, "results.json");
  const htmlReportDir = resolvePath(REPORTS_DIR, "html");

  if (!execute) {
    return { status: 0, jsonReportPath, htmlReportDir, stdout: "", stderr: "" };
  }

  const proc = spawnSync("npx", buildArgs(target, extraArgs), {
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

export { GENERATED_TESTS_DIR, REPORTS_DIR };
