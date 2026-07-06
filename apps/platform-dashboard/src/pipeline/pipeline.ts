// Client bindings for triggering and polling an authoring-pipeline job via
// /api/pipeline/run. The job snapshot is the SAME shape the suite runner returns
// (one global single-flight lock on the server), so a run started here or from the
// Test Runner both surface as the one "busy" status.

/**
 * The authoring stages the dashboard can trigger. `test:all` runs the full suite
 * through the same single-flight lock so the pipeline view's Run stage shares the
 * pipeline's busy state (slice-level suite control stays in the Test Runner view).
 */
export type PipelineJob =
  | "ingest"
  | "mine"
  | "invariants:propose"
  | "invariants:verify"
  | "generate"
  | "repair"
  | "triage"
  | "test:all";

export interface JobParams {
  /** behavior:mine — minimum support threshold (positive integer). */
  minSupport?: number;
  /** script-generator:repair — scope to specs whose path contains this substring. */
  only?: string;
}

export interface JobStatus {
  state: "idle" | "running" | "passed" | "failed";
  /** The job id currently/last run, e.g. "mine" or "test:all"; null before any run. */
  job: string | null;
  target: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output: string;
}

export async function fetchJobStatus(): Promise<JobStatus> {
  const response = await fetch("/api/pipeline/run");
  if (!response.ok) {
    throw new Error(`/api/pipeline/run returned ${response.status}`);
  }
  return (await response.json()) as JobStatus;
}

/** Start a pipeline job. Resolves with the initial status, or throws (e.g. 409 if one is going). */
export async function startJob(job: PipelineJob, params?: JobParams): Promise<JobStatus> {
  const response = await fetch("/api/pipeline/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job, params: params ?? {} }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    status?: JobStatus;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `/api/pipeline/run returned ${response.status}`);
  }
  return body.status ?? (await fetchJobStatus());
}
