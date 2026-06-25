/**
 * Runs the project's Playwright suite on the operator's behalf so the browser can trigger
 * `npm run test:<target>` without filesystem/shell access of its own. A test run takes minutes
 * and needs the SUT (Medusa stack) up, so this is a fire-and-poll job: POST starts it, GET
 * reports a snapshot the UI polls. Only one run at a time — a second POST while busy is a 409.
 *
 * The runner writes reports/report.html (+ archives under reports/runs/), which the existing
 * report endpoints already serve, so the Reports view refreshes itself once a run finishes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { REPO_ROOT } from "./hitl-store.js";

export type RunTarget = "all" | "guest" | "customer" | "admin" | "happy" | "failure";

const VALID_TARGETS: RunTarget[] = ["all", "guest", "customer", "admin", "happy", "failure"];

export function isValidTarget(value: unknown): value is RunTarget {
  return typeof value === "string" && (VALID_TARGETS as string[]).includes(value);
}

export type RunState = "idle" | "running" | "passed" | "failed";

export interface RunStatus {
  state: RunState;
  target: RunTarget | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  /** Rolling tail of combined stdout/stderr, capped so the snapshot stays small. */
  output: string;
}

const MAX_OUTPUT = 64 * 1024;

let status: RunStatus = {
  state: "idle",
  target: null,
  started_at: null,
  finished_at: null,
  exit_code: null,
  output: "",
};
let child: ChildProcess | null = null;

export function getTestRunStatus(): RunStatus {
  return status;
}

export function startTestRun(target: RunTarget): { started: boolean; reason?: string } {
  if (status.state === "running") {
    return { started: false, reason: "a test run is already in progress" };
  }

  status = {
    state: "running",
    target,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    output: "",
  };

  const append = (chunk: Buffer): void => {
    status.output = (status.output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
  };

  // `npm run test:<target>` from the repo root maps to the test-runner CLI (see root package.json).
  const proc = spawn("npm", ["run", `test:${target}`], { cwd: REPO_ROOT, env: process.env });
  child = proc;

  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  proc.on("error", (err) => {
    append(Buffer.from(`\n[failed to start test runner] ${err.message}\n`));
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
