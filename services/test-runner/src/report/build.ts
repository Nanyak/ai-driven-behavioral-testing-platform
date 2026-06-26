/**
 * Aggregate the NormalizedRunResult into a stakeholder report: totals,
 * per-persona, per-flow, and endpoint-failure rollups, with one failure entry
 * per failing step carrying expected/actual status, golden diff, duration, and
 * source provenance.
 *
 * Pure + deterministic: same input -> byte-identical output given a fixed
 * `runId`/`now`. All ordering is stable so a diff between two runs is meaningful
 * (the regression demo relies on this).
 */
import type { NormalizedRunResult, NormalizedTest } from "../collect.js";
import {
  summarizeGoldenDiff,
  summarizeValueDiff,
  type EndpointFailure,
  type FailureEntry,
  type FlowRollup,
  type PersonaRollup,
  type Report,
} from "./schema.js";

export interface BuildOptions {
  /** Stable run id; derived from `now` when omitted. */
  runId?: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

function isFailed(status: NormalizedTest["status"]): boolean {
  return status === "failed" || status === "timedOut" || status === "interrupted";
}

/** `run-YYYY-MM-DD-HHMMSS` in UTC. */
function deriveRunId(now: Date): string {
  const iso = now.toISOString();
  const [date, time] = iso.split("T");
  return `run-${date}-${time.slice(0, 8).replace(/:/g, "")}`;
}

export function buildReport(result: NormalizedRunResult, opts: BuildOptions = {}): Report {
  const now = opts.now ?? new Date(result.generated_at);
  const runId = opts.runId ?? deriveRunId(Number.isNaN(now.getTime()) ? new Date() : now);

  const personaMap = new Map<string, PersonaRollup>();
  const flowMap = new Map<string, FlowRollup>();
  const endpointMap = new Map<string, number>();
  const failures: FailureEntry[] = [];

  for (const test of result.tests) {
    const prow = personaMap.get(test.persona) ?? { persona: test.persona, passed: 0, failed: 0, skipped: 0 };
    // Per-flow rollup, keyed by signature when present (persona-independent
    // identity, ADR 0002), else persona+name.
    const flowKey = test.flow_signature ?? `${test.persona}::${test.flow_name}`;
    const frow =
      flowMap.get(flowKey) ??
      ({ flow_name: test.flow_name, persona: test.persona, flow_signature: test.flow_signature, passed: 0, failed: 0, skipped: 0 } as FlowRollup);

    if (test.status === "passed") {
      prow.passed++;
      frow.passed++;
    } else if (test.status === "skipped") {
      prow.skipped++;
      frow.skipped++;
    } else {
      prow.failed++;
      frow.failed++;
    }
    personaMap.set(test.persona, prow);
    flowMap.set(flowKey, frow);

    if (!isFailed(test.status)) continue;

    // One failure entry per failing request step; if the test failed before any
    // request step captured it (e.g. setup/register), emit a single placeholder
    // so the persona/flow failure is still attributable.
    const failedSteps = test.steps.filter((s) => s.status === "failed");
    if (failedSteps.length === 0) {
      failures.push(makeFailure(test, "(no request step)", null, null, null, null, test.duration_ms, null));
      continue;
    }
    for (const step of failedSteps) {
      endpointMap.set(step.endpoint, (endpointMap.get(step.endpoint) ?? 0) + 1);
      failures.push(
        makeFailure(
          test,
          step.endpoint,
          step.expected_status,
          step.actual_status,
          summarizeGoldenDiff(step.golden_diff),
          summarizeValueDiff(step.value_diff),
          step.duration_ms,
          step.failure_message,
        ),
      );
    }
  }

  const by_persona = [...personaMap.values()].sort((a, b) => a.persona.localeCompare(b.persona));
  const by_flow = [...flowMap.values()].sort(
    (a, b) => a.persona.localeCompare(b.persona) || a.flow_name.localeCompare(b.flow_name),
  );
  const endpoint_failures: EndpointFailure[] = [...endpointMap.entries()]
    .map(([endpoint, count]) => ({ endpoint, failures: count }))
    .sort((a, b) => b.failures - a.failures || a.endpoint.localeCompare(b.endpoint));
  const hasExecutedEvidence = result.totals.executed > 0 && result.totals.passed + result.totals.failed > 0;

  return {
    run_id: runId,
    generated_at: result.generated_at,
    status: !hasExecutedEvidence ? "invalid" : result.totals.failed > 0 ? "red" : "green",
    totals: result.totals,
    by_persona,
    by_flow,
    endpoint_failures,
    failures,
  };
}

function makeFailure(
  test: NormalizedTest,
  endpoint: string,
  expected: number | null,
  actual: number | null,
  goldenDiff: FailureEntry["golden_diff"],
  valueDiff: FailureEntry["value_diff"] | null,
  durationMs: number,
  message: string | null,
): FailureEntry {
  const entry: FailureEntry = {
    flow_name: test.flow_name,
    persona: test.persona,
    flow_signature: test.flow_signature,
    endpoint,
    expected_status: expected,
    actual_status: actual,
    golden_diff: goldenDiff,
    duration_ms: durationMs,
    source_sessions: test.source_sessions,
    failure_message: message,
  };
  // Carry value_diff only when value rules actually fired, so reports without a
  // value regression stay byte-identical to the pre-Tier-A format.
  if (valueDiff && valueDiff.length > 0) entry.value_diff = valueDiff;
  // Carry trace_id only when upstream actually supplied one (never invented).
  if (test.trace_id !== undefined && test.trace_id !== null) entry.trace_id = test.trace_id;
  return entry;
}
