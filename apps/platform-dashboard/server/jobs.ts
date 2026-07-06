/**
 * Generic single-flight job runner for the authoring pipeline (mine → generate →
 * repair → run → triage). Generalizes the original `test-run.ts` manager: the
 * browser can trigger any ALLOWLISTED `npm run …` script without filesystem/shell
 * access of its own. A job takes minutes and most need the SUT (Medusa stack) up,
 * so this is fire-and-poll: POST starts it, GET reports a snapshot the UI polls.
 *
 * One job at a time, globally. Pipeline stages are sequential and contend for the
 * SUT and reports/ — a second start while busy is a 409. `test-run.ts` delegates
 * here so a browser-started suite run shares the SAME lock/snapshot as a pipeline
 * job (the UI shows "busy" consistently regardless of which started it).
 *
 * Security: argv is built ONLY from this fixed registry; user-supplied params are
 * validated and slotted into fixed flag positions. `spawn` runs with an arg array
 * (no shell), so nothing is interpolated into a command line — the validation is
 * belt-and-suspenders so a bad param is rejected (400) rather than reaching argv.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { getDir, makeLocalStorage, putDir, storage } from "../../../packages/storage/index.js";
import { makePgPool } from "../../../packages/storage/postgres.js";
import { REPO_ROOT } from "./hitl-store.js";

/** The six suite targets the test-runner accepts (mirrors test-run.ts). */
export type RunTarget = "all" | "guest" | "customer" | "admin" | "happy" | "failure" | "drafts";
const RUN_TARGETS: RunTarget[] = ["all", "guest", "customer", "admin", "happy", "failure", "drafts"];

/** Pipeline-authoring jobs the dashboard can trigger, plus the per-target suite runs. */
export type JobId =
  | "ingest"
  | "mine"
  | "invariants"
  | "invariants:propose"
  | "invariants:verify"
  | "generate"
  | "repair"
  | "triage"
  | `test:${RunTarget}`;

export interface JobParams {
  /** behavior:mine — minimum support threshold; positive integer when present. */
  minSupport?: number | string;
  /** script-generator:repair — scope to specs whose relPath contains this substring. */
  only?: string;
}

interface JobSpec {
  /** Human label for logs/UI. */
  label: string;
  /** Base `npm run …` argv (params are appended by buildArgv). */
  argv: string[];
  /** True when the job mutates the repo (specs/reports) — advisory for the UI. */
  mutating: boolean;
  /** True when the job needs the live SUT reachable — advisory for the UI. */
  needsSut: boolean;
}

/** The complete allowlist. A job id absent here is rejected before any spawn. */
const JOBS: Record<string, JobSpec> = {
  ingest: { label: "Ingest logs", argv: ["run", "ingest:run"], mutating: true, needsSut: false },
  mine: { label: "Mine flows", argv: ["run", "behavior:mine"], mutating: true, needsSut: false },
  invariants: { label: "Propose invariants", argv: ["run", "script-generator:invariants"], mutating: true, needsSut: false },
  "invariants:propose": {
    label: "Propose invariants",
    argv: ["run", "script-generator:invariants"],
    mutating: true,
    needsSut: false,
  },
  "invariants:verify": {
    label: "Verify invariants",
    argv: ["run", "script-generator:invariants:verify"],
    mutating: true,
    needsSut: false,
  },
  generate: { label: "Generate tests", argv: ["run", "script-generator:generate"], mutating: true, needsSut: false },
  repair: { label: "Repair (agent)", argv: ["run", "script-generator:repair"], mutating: true, needsSut: true },
  triage: { label: "Triage report", argv: ["run", "triage"], mutating: true, needsSut: false },
  ...Object.fromEntries(
    RUN_TARGETS.map((t) => [
      `test:${t}`,
      { label: `Run suite (${t})`, argv: ["run", `test:${t}`], mutating: false, needsSut: true } satisfies JobSpec,
    ])
  ),
};

export function isJobId(value: unknown): value is JobId {
  return typeof value === "string" && value in JOBS;
}

export type RunState = "idle" | "running" | "passed" | "failed";

export interface JobStatus {
  state: RunState;
  /** The job id currently/last running (e.g. "mine", "test:all"); null before any run. */
  job: JobId | null;
  /** Suite target when the job is a `test:<target>` run, else null (back-compat for the runner UI). */
  target: RunTarget | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  /** Rolling tail of combined stdout/stderr, capped so the snapshot stays small. */
  output: string;
}

const MAX_OUTPUT = 64 * 1024;

let status: JobStatus = {
  state: "idle",
  job: null,
  target: null,
  started_at: null,
  finished_at: null,
  exit_code: null,
  output: "",
};
let child: ChildProcess | null = null;
let starting = false;

interface JobWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function linkNodeModules(workspace: string): Promise<void> {
  const source = resolvePath(REPO_ROOT, "generated-tests", "node_modules");
  const destination = resolvePath(workspace, "generated-tests", "node_modules");
  try {
    if (!(await lstat(source)).isDirectory()) return;
    await rm(destination, { recursive: true, force: true });
    await symlink(source, destination, "dir");
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

async function hydrateRecord(
  local: ReturnType<typeof makeLocalStorage>,
  key: "hitl/approvals" | "hitl/dismissed-relationships" | "manifest" | "run-index"
): Promise<void> {
  const value = await storage.records.readJson(key);
  if (value !== null) await local.records.writeJson(key, value);
}

async function prepareWorkspace(job: JobId): Promise<JobWorkspace | null> {
  if ((process.env.STORAGE_BACKEND ?? "local") !== "remote") return null;

  const root = await mkdtemp(
    resolvePath(tmpdir(), `behavior-platform-${job.replace(/[^A-Za-z0-9_-]/g, "-")}-`)
  );
  const generated = resolvePath(root, "generated-tests");
  await mkdir(generated, { recursive: true });

  if (job === "mine") {
    const count = await getDir(
      storage.blobs,
      "sessions",
      resolvePath(root, "data", "sessions")
    );
    if (count === 0) {
      throw new Error("No sessions/session-flows-*.json exists; run ingest first.");
    }
  }
  const proposingInvariants = job === "invariants" || job === "invariants:propose";
  if (job === "generate" || proposingInvariants) {
    await getDir(
      storage.blobs,
      "candidates",
      resolvePath(root, "services", "behavior-engine", "data", "candidates")
    );
  }
  if (job === "generate" || job === "repair" || job.startsWith("test:")) {
    // repair re-executes real specs (verifySpec -> runPlaywright); happy-path
    // specs assertGolden against golden-responses/ and fail closed without them.
    await getDir(storage.blobs, "goldens", resolvePath(root, "golden-responses"));
  }
  if (proposingInvariants) {
    await getDir(
      storage.blobs,
      "endpoint-behavior",
      resolvePath(root, "data", "endpoint-behavior")
    );
  }
  if (job === "repair" || job.startsWith("test:")) {
    await getDir(storage.blobs, "specs", generated);
  }
  if (job === "triage") {
    await getDir(storage.blobs, "reports", resolvePath(root, "reports"));
  }
  if (job === "invariants:verify") {
    const normalized = await storage.blobs.get("reports/playwright/normalized.json");
    if (normalized === null) {
      throw new Error(
        "No reports/playwright/normalized.json exists in object storage; run a test job before invariant verification."
      );
    }
    const destination = resolvePath(root, "reports", "playwright", "normalized.json");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, normalized);
  }

  await Promise.all([
    copyIfPresent(
      resolvePath(REPO_ROOT, "generated-tests", "package.json"),
      resolvePath(generated, "package.json")
    ),
    copyIfPresent(
      resolvePath(REPO_ROOT, "generated-tests", "package-lock.json"),
      resolvePath(generated, "package-lock.json")
    ),
    copyIfPresent(
      resolvePath(REPO_ROOT, "generated-tests", "tsconfig.json"),
      resolvePath(generated, "tsconfig.json")
    ),
    linkNodeModules(root),
  ]);

  const local = makeLocalStorage(root);
  await Promise.all([
    hydrateRecord(local, "hitl/approvals"),
    hydrateRecord(local, "hitl/dismissed-relationships"),
    hydrateRecord(local, "manifest"),
    hydrateRecord(local, "run-index"),
  ]);

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function persistWorkspace(job: JobId, workspace: JobWorkspace | null): Promise<void> {
  if (!workspace) return;
  if (job === "ingest") {
    await putDir(
      storage.blobs,
      resolvePath(workspace.root, "data", "sessions"),
      "sessions",
      (path) => /^session-flows-.+\.json$/.test(path)
    );
    await putDir(storage.blobs, resolvePath(workspace.root, "golden-responses"), "goldens");
  }
  if (job === "generate") {
    await putDir(storage.blobs, resolvePath(workspace.root, "golden-responses"), "goldens");
  }
  if (job === "invariants" || job === "invariants:propose") {
    await putDir(
      storage.blobs,
      resolvePath(workspace.root, "data", "endpoint-behavior"),
      "endpoint-behavior",
      (path) => path.endsWith(".md")
    );
  }
  if (job === "repair") {
    await putDir(
      storage.blobs,
      resolvePath(workspace.root, "generated-tests"),
      "specs",
      (path) => /^(guest|customer|admin)\/.+\.spec\.ts$/.test(path)
    );
  }
  if (job === "repair" || job === "triage" || job.startsWith("test:")) {
    await putDir(storage.blobs, resolvePath(workspace.root, "reports"), "reports");
  }
}

export function getJobStatus(): JobStatus {
  return status;
}

export type StartResult =
  | { started: true }
  | { started: false; reason: string; code: 409 | 400 };

/**
 * Validate `params` against the job and append them to the base argv in fixed flag
 * positions. Returns the argv, or an error string for a 400. Unknown params are ignored.
 */
function buildArgv(job: JobId, params: JobParams): string[] | { error: string } {
  const argv = [...JOBS[job].argv];
  if (job === "mine" && params.minSupport !== undefined && params.minSupport !== "") {
    const n = Number(params.minSupport);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: "minSupport must be a positive integer" };
    }
    // The root script forwards args after `--` to the behavior-engine CLI.
    argv.push("--", "--min-support", String(n));
  }
  if (job === "repair" && params.only !== undefined && params.only !== "") {
    const only = String(params.only);
    if (!/^[A-Za-z0-9/_.-]+$/.test(only)) {
      return { error: "only must match [A-Za-z0-9/_.-]+ (a spec hash or path fragment)" };
    }
    // `script-generator:repair` already passes `--` to run.ts; forward --only after it.
    argv.push("--", "--only", only);
  }
  return argv;
}

async function acquireDistributedLock(): Promise<(() => Promise<void>) | null> {
  if ((process.env.STORAGE_BACKEND ?? "local") !== "remote") {
    return async () => undefined;
  }
  const pool = makePgPool();
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as acquired",
      ["behavior-platform:pipeline"]
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      await pool.end();
      return null;
    }
    return async () => {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [
          "behavior-platform:pipeline",
        ]);
      } finally {
        client.release();
        await pool.end();
      }
    };
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }
}

export async function startJob(job: JobId, params: JobParams = {}): Promise<StartResult> {
  if (status.state === "running" || starting) {
    return { started: false, reason: "a job is already in progress", code: 409 };
  }
  const built = buildArgv(job, params);
  if (!Array.isArray(built)) {
    return { started: false, reason: built.error, code: 400 };
  }

  starting = true;
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireDistributedLock();
  } catch (error) {
    starting = false;
    return {
      started: false,
      reason: `failed to acquire pipeline lock: ${error instanceof Error ? error.message : String(error)}`,
      code: 409,
    };
  }
  if (!releaseLock) {
    starting = false;
    return { started: false, reason: "a job is already running on another replica", code: 409 };
  }

  const target = job.startsWith("test:") ? (job.slice("test:".length) as RunTarget) : null;
  status = {
    state: "running",
    job,
    target,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    output: "",
  };
  starting = false;

  const append = (chunk: Buffer): void => {
    status.output = (status.output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
  };

  void (async () => {
    let workspace: JobWorkspace | null = null;
    try {
      workspace = await prepareWorkspace(job);
      const env = workspace
        ? { ...process.env, STORAGE_WORKSPACE_ROOT: workspace.root }
        : process.env;
      const proc = spawn("npm", built, { cwd: REPO_ROOT, env });
      child = proc;

      proc.stdout?.on("data", append);
      proc.stderr?.on("data", append);
      proc.on("error", (err) => {
        append(Buffer.from(`\n[failed to start job] ${err.message}\n`));
      });
      const code = await new Promise<number>((resolve) => {
        proc.once("error", () => resolve(-1));
        proc.once("close", (exitCode) => resolve(exitCode ?? -1));
      });
      await persistWorkspace(job, workspace);
      status.exit_code = code;
      status.state = code === 0 ? "passed" : "failed";
    } catch (error) {
      append(
        Buffer.from(
          `\n[job storage failure] ${error instanceof Error ? error.message : String(error)}\n`
        )
      );
      status.exit_code = -1;
      status.state = "failed";
    } finally {
      status.finished_at = new Date().toISOString();
      child = null;
      try {
        await workspace?.cleanup();
      } catch (error) {
        append(
          Buffer.from(
            `\n[workspace cleanup failure] ${error instanceof Error ? error.message : String(error)}\n`
          )
        );
      } finally {
        try {
          await releaseLock?.();
        } catch (error) {
          append(
            Buffer.from(
              `\n[job lock release failure] ${error instanceof Error ? error.message : String(error)}\n`
            )
          );
        }
      }
    }
  })();

  return { started: true };
}
