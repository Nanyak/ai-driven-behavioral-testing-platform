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
import { REPO_ROOT } from "./hitl-store.js";

/** The six suite targets the test-runner accepts (mirrors test-run.ts). */
export type RunTarget = "all" | "guest" | "customer" | "admin" | "happy" | "failure";
const RUN_TARGETS: RunTarget[] = ["all", "guest", "customer", "admin", "happy", "failure"];

/** Pipeline-authoring jobs the dashboard can trigger, plus the per-target suite runs. */
export type JobId = "mine" | "generate" | "repair" | "triage" | `test:${RunTarget}`;

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
  mine: { label: "Mine flows", argv: ["run", "behavior:mine"], mutating: true, needsSut: false },
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

export function startJob(job: JobId, params: JobParams = {}): StartResult {
  if (status.state === "running") {
    return { started: false, reason: "a job is already in progress", code: 409 };
  }
  const built = buildArgv(job, params);
  if (!Array.isArray(built)) {
    return { started: false, reason: built.error, code: 400 };
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

  const append = (chunk: Buffer): void => {
    status.output = (status.output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
  };

  const proc = spawn("npm", built, { cwd: REPO_ROOT, env: process.env });
  child = proc;

  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  proc.on("error", (err) => {
    append(Buffer.from(`\n[failed to start job] ${err.message}\n`));
    status.state = "failed";
    status.exit_code = -1;
    status.finished_at = new Date().toISOString();
    child = null;
  });
  proc.on("close", (code) => {
    status.exit_code = code ?? -1;
    status.state = code === 0 ? "passed" : "failed";
    status.finished_at = new Date().toISOString();
    child = null;
  });

  return { started: true };
}
