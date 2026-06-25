export type Decision = "approved" | "discarded";

/**
 * The test file is generated BEFORE review by the script-generator — approve/discard never
 * create or delete it.
 */
export type Lifecycle = "approved" | "discarded" | "awaiting_review" | "discovered";

export interface FlowStep {
  method: string;
  endpoint: string;
  expected_status: number;
}

export interface ReviewFlow {
  signature: string;
  flow_name: string;
  persona: string;
  attributes: { requires_auth: boolean; is_admin: boolean; has_errors: boolean };
  priority: string;
  support: number;
  score: number;
  step_count: number;
  steps: FlowStep[];
  assertion_fields: string[];
  source_sessions: string[];
  test_path: string | null;
  decision: Decision | null;
  covered: boolean;
  route_key: string;
  status_signature: string;
  lifecycle: Lifecycle;
  conflicts_with_approved: boolean;
  conflict_signatures: string[];
  conflict_baselines: Array<{ flow_name: string; status_signature: string }>;
  /** The on-disk spec was repaired by the resolver-agent (carries its provenance stamp). */
  repaired_by_agent: boolean;
  /** Agent repair attempts from the last repair run (null when not repaired). */
  repair_attempts: number | null;
}

export interface RepairDiff {
  signature: string;
  flow_name: string;
  attempts: number;
  before: string;
  after: string;
}

export interface PriorDecision {
  signature: string;
  status: Decision;
  flow_name: string;
  persona: string;
  route_key: string;
  status_signature: string;
  step_count: number;
  decided_at?: string;
}

export interface FlowsPayload {
  run_id: string | null;
  source_candidates: string | null;
  generated_at: string | null;
  flows: ReviewFlow[];
  prior_decisions: PriorDecision[];
  counts: {
    total: number;
    approved: number;
    discarded: number;
    undecided: number;
    with_test: number;
    covered: number;
    awaiting_review: number;
    discovered: number;
    conflicts: number;
  };
}

export async function fetchFlows(): Promise<FlowsPayload> {
  const response = await fetch("/api/flows");
  if (!response.ok) {
    throw new Error(`/api/flows returned ${response.status}`);
  }
  return (await response.json()) as FlowsPayload;
}

/** Fetch the before/after sources for a resolver-agent-repaired flow (404 -> null). */
export async function fetchRepairDiff(signature: string): Promise<RepairDiff | null> {
  const response = await fetch(`/api/repair/diff?signature=${encodeURIComponent(signature)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`/api/repair/diff returned ${response.status}`);
  return (await response.json()) as RepairDiff;
}

/**
 * Persist a decision. Sends the flow's identity metadata too so the store can
 * show review history and detect drift after the flow leaves the latest scan.
 */
export async function postDecision(flow: ReviewFlow, status: Decision): Promise<void> {
  const response = await fetch("/api/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flow_signature: flow.signature,
      status,
      test_path: flow.test_path,
      flow_name: flow.flow_name,
      persona: flow.persona,
      route_key: flow.route_key,
      status_signature: flow.status_signature,
      step_count: flow.step_count,
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `/api/decisions returned ${response.status}`);
  }
}

/**
 * Delete the generated `.spec.ts` for a flow. The server unlinks it (path-scoped to
 * generated-tests/) — this is distinct from discarding, which only records a judgment.
 */
export async function deleteTest(flow: ReviewFlow): Promise<void> {
  if (!flow.test_path) {
    throw new Error("This flow has no generated test to delete.");
  }
  const response = await fetch("/api/tests/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ test_path: flow.test_path }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `/api/tests/delete returned ${response.status}`);
  }
}
