/**
 * Suite-run façade over the generic job manager (`jobs.ts`). Kept as a thin,
 * back-compatible wrapper so the existing `/api/tests/run` route and the Test
 * Runner view need no changes: starting a suite run is just `startJob("test:<target>")`,
 * which shares the SAME single-flight lock and snapshot as the pipeline jobs.
 */
import { getJobStatus, isJobId, startJob, type JobStatus, type RunTarget } from "./jobs.js";

export type { RunTarget } from "./jobs.js";
export type RunStatus = JobStatus;

const VALID_TARGETS: RunTarget[] = ["all", "guest", "customer", "admin", "happy", "failure"];

export function isValidTarget(value: unknown): value is RunTarget {
  return typeof value === "string" && (VALID_TARGETS as string[]).includes(value);
}

export function getTestRunStatus(): RunStatus {
  return getJobStatus();
}

export function startTestRun(target: RunTarget): { started: boolean; reason?: string } {
  const job = `test:${target}` as const;
  // isJobId guards the registry; target is already validated by the route.
  if (!isJobId(job)) {
    return { started: false, reason: `unknown suite target: ${target}` };
  }
  const result = startJob(job);
  return result.started ? { started: true } : { started: false, reason: result.reason };
}
