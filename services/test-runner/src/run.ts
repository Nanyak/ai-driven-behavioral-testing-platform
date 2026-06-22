/**
 * Env vars use the CANONICAL repo-wide names (root .env / .env.example,
 * services/traffic-generator/src/config/config.ts), which the generated specs +
 * fixtures/auth.ts also read. Precedence: process.env > service .env >
 * repo-root .env, mirroring config.ts, so a bare `npm run test:guest` picks up
 * the same key the rest of the stack uses.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolvePath(__dirname, "..");
const REPO_ROOT = resolvePath(SERVICE_ROOT, "..", "..");
const GENERATED_TESTS_DIR = resolvePath(REPO_ROOT, "generated-tests");
const REPORTS_DIR = resolvePath(REPO_ROOT, "reports", "playwright");
const REPO_REPORTS_DIR = resolvePath(REPO_ROOT, "reports");

export type Project = "guest" | "customer" | "admin" | "edge";
export type Target = Project | "all";

export const PROJECTS: Project[] = ["guest", "customer", "admin", "edge"];

export interface RunOptions {
  target: Target;
  execute?: boolean;
  extraArgs?: string[];
}

export interface RunResult {
  status: number;
  jsonReportPath: string;
  htmlReportDir: string;
  stdout: string;
  stderr: string;
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
export function buildArgs(target: Target, extraArgs: string[] = []): string[] {
  const args = ["playwright", "test"];
  if (target !== "all") {
    args.push("--project", target);
  }
  args.push(...extraArgs);
  return args;
}

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

export { GENERATED_TESTS_DIR, REPORTS_DIR, REPO_REPORTS_DIR };
