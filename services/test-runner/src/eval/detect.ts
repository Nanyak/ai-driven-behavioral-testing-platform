/**
 * Pure caught-detection over normalized run results — no I/O, unit-testable.
 *
 * A fault is CAUGHT when the suite develops a NET-NEW failure on the fault's
 * target endpoint: a failed step on that endpoint under the fault that was NOT
 * already failing at baseline. Requiring net-new avoids crediting a fault for a
 * pre-existing red (e.g. an unrelated flaky step), which would inflate the
 * detection rate. Detection is endpoint-scoped, not assertion-message-scoped, so
 * it stays robust to invariant-message wording changes.
 */
import type { NormalizedRunResult, NormalizedTest } from "../collect.js";
import type { EvalFault } from "./catalog.js";

export interface CaughtVerdict {
  caught: boolean;
  /** Title of the test whose target-endpoint step failed under the fault. */
  catchingTest: string | null;
  /** Failure message excerpt (first line) for the metrics report evidence. */
  evidence: string | null;
  /** True when the target endpoint was ALREADY failing at baseline (fault not attributable). */
  baselinePreexistingFailure: boolean;
}

/** The failed step on `endpoint` within a test, or null. */
function failedStepOn(test: NormalizedTest, endpoint: string): { message: string | null } | null {
  for (const step of test.steps) {
    if (step.endpoint === endpoint && step.status === "failed") {
      return { message: step.failure_message };
    }
  }
  return null;
}

/** Does ANY test in the result have a failed step on `endpoint`? */
function anyFailureOn(result: NormalizedRunResult, endpoint: string): boolean {
  return result.tests.some((t) => failedStepOn(t, endpoint) !== null);
}

function firstLine(message: string | null): string | null {
  if (!message) return null;
  const line = message.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 300) : null;
}

/**
 * Classify a single fault run against the baseline.
 *
 * @param baseline result of the clean (no-fault) run — may be null when the
 *   harness runs with `--no-baseline`, in which case any target-endpoint failure
 *   counts as caught (baseline attribution is skipped).
 */
export function classifyFault(
  fault: EvalFault,
  faultRun: NormalizedRunResult,
  baseline: NormalizedRunResult | null
): CaughtVerdict {
  const baselineFailing = baseline !== null && anyFailureOn(baseline, fault.targetEndpoint);

  let catchingTest: string | null = null;
  let evidence: string | null = null;
  for (const test of faultRun.tests) {
    const failed = failedStepOn(test, fault.targetEndpoint);
    if (failed) {
      catchingTest = test.flow_name || test.title;
      evidence = firstLine(failed.message);
      break;
    }
  }

  const faultFailing = catchingTest !== null;
  // Caught = fault-induced failure that isn't a carryover of a baseline red.
  const caught = faultFailing && !baselineFailing;

  return {
    caught,
    catchingTest: caught ? catchingTest : null,
    evidence: caught ? evidence : null,
    baselinePreexistingFailure: baselineFailing,
  };
}
