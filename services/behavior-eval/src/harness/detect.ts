import type { NormalizedRunResult, NormalizedTest } from "../../../test-runner/src/collect.js";
import type { Mutant } from "../types.js";

export interface MutationVerdict {
  killed: boolean;
  catchingSpec: string | null;
  evidence: string | null;
  baselinePreexistingFailure: boolean;
}

function failedStepOn(test: NormalizedTest, endpoint: string): { message: string | null } | null {
  for (const step of test.steps) {
    if (step.endpoint === endpoint && step.status === "failed") {
      return { message: step.failure_message };
    }
  }
  return null;
}

function anyFailureOn(result: NormalizedRunResult, endpoint: string): boolean {
  return result.tests.some((test) => failedStepOn(test, endpoint) !== null);
}

function firstLine(message: string | null): string | null {
  if (!message) return null;
  const line = message.split("\n").find((part) => part.trim().length > 0);
  return line ? line.trim().slice(0, 300) : null;
}

export function classifyMutation(
  mutant: Mutant,
  faultRun: NormalizedRunResult,
  baseline: NormalizedRunResult
): MutationVerdict {
  const baselineFailing = anyFailureOn(baseline, mutant.endpoint);
  let catchingSpec: string | null = null;
  let evidence: string | null = null;

  for (const test of faultRun.tests) {
    const failed = failedStepOn(test, mutant.endpoint);
    if (failed) {
      catchingSpec = test.file;
      evidence = firstLine(failed.message);
      break;
    }
  }

  return {
    killed: catchingSpec !== null && !baselineFailing,
    catchingSpec: catchingSpec !== null && !baselineFailing ? catchingSpec : null,
    evidence: catchingSpec !== null && !baselineFailing ? evidence : null,
    baselinePreexistingFailure: baselineFailing,
  };
}
