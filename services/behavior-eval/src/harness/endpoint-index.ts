import type { NormalizedRunResult } from "../../../test-runner/src/collect.js";

export function buildEndpointSpecIndex(result: NormalizedRunResult): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const test of result.tests) {
    for (const step of test.steps) {
      const specs = index.get(step.endpoint) ?? new Set<string>();
      specs.add(test.file);
      index.set(step.endpoint, specs);
    }
  }
  return index;
}
