// Client bindings for triggering and polling a test run via /api/tests/run.

export type RunTarget = "all" | "guest" | "customer" | "admin" | "happy" | "failure" | "drafts";

export const RUN_TARGETS: RunTarget[] = [
  "all",
  "guest",
  "customer",
  "admin",
  "happy",
  "failure",
  "drafts",
];

export interface TestRunStatus {
  state: "idle" | "running" | "passed" | "failed";
  target: RunTarget | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output: string;
}

export async function fetchTestRunStatus(): Promise<TestRunStatus> {
  const response = await fetch("/api/tests/run");
  if (!response.ok) {
    throw new Error(`/api/tests/run returned ${response.status}`);
  }
  return (await response.json()) as TestRunStatus;
}

/** Start a run. Resolves with the initial status, or throws (e.g. 409 if one is already going). */
export async function startTestRun(target: RunTarget): Promise<TestRunStatus> {
  const response = await fetch("/api/tests/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    status?: TestRunStatus;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `/api/tests/run returned ${response.status}`);
  }
  return body.status ?? (await fetchTestRunStatus());
}
