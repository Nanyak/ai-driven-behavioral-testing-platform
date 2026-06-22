import type { SchemaDiffEntry } from "../../golden/src/compare.js";
import type { NormalizedStep, NormalizedTest } from "./collect.js";

export function formatGoldenDiff(diff: SchemaDiffEntry[] | null): string | null {
  if (!diff || diff.length === 0) return null;
  const lines = diff.map((d) => {
    switch (d.kind) {
      case "missing_field":
        return `    - missing   ${d.path} (expected ${JSON.stringify(d.expected)})`;
      case "unexpected_field":
        return `    + extra     ${d.path} (got ${JSON.stringify(d.actual)})`;
      case "type_changed":
        return `    ~ type      ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`;
      default:
        return `    ? ${d.path}`;
    }
  });
  return lines.join("\n");
}

export function formatStepFailure(test: NormalizedTest, step: NormalizedStep): string {
  const lines: string[] = [];
  lines.push(`  ✗ ${test.persona} / ${test.flow_name}`);
  lines.push(`    step:     ${step.endpoint}`);
  if (step.expected_status !== null || step.actual_status !== null) {
    lines.push(`    status:   expected ${step.expected_status ?? "?"}, actual ${step.actual_status ?? "?"}`);
  }
  const diff = formatGoldenDiff(step.golden_diff);
  if (diff) {
    lines.push(`    golden diff:`);
    lines.push(diff);
  }
  if (step.failure_message && step.expected_status === null && step.actual_status === null) {
    // Not a status mismatch (e.g. a thrown resolver error) — fall back to the raw message.
    lines.push(`    error:    ${step.failure_message.split("\n")[0]}`);
  }
  return lines.join("\n");
}

export function formatFailures(tests: NormalizedTest[]): string {
  const blocks: string[] = [];
  for (const test of tests) {
    if (test.status === "passed" || test.status === "skipped") continue;
    const failedSteps = test.steps.filter((s) => s.status === "failed");
    if (failedSteps.length === 0) {
      // No request step captured the failure — e.g. a setup/register call threw before any test.step().
      blocks.push(`  ✗ ${test.persona} / ${test.flow_name}\n    (test failed before any request step; see Playwright HTML report)`);
      continue;
    }
    for (const step of failedSteps) {
      blocks.push(formatStepFailure(test, step));
    }
  }
  return blocks.join("\n\n");
}
