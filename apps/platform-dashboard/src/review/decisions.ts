// Client-side bindings for the HITL review endpoint (Phase 15).

export type Decision = "approved" | "discarded";

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
}

export interface FlowsPayload {
  run_id: string | null;
  source_candidates: string | null;
  generated_at: string | null;
  flows: ReviewFlow[];
  counts: {
    total: number;
    approved: number;
    discarded: number;
    undecided: number;
    with_test: number;
    covered: number;
  };
}

export async function fetchFlows(): Promise<FlowsPayload> {
  const response = await fetch("/api/flows");
  if (!response.ok) {
    throw new Error(`/api/flows returned ${response.status}`);
  }
  return (await response.json()) as FlowsPayload;
}

export async function postDecision(
  flowSignature: string,
  status: Decision,
  testPath: string | null
): Promise<void> {
  const response = await fetch("/api/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flow_signature: flowSignature, status, test_path: testPath }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `/api/decisions returned ${response.status}`);
  }
}
