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
