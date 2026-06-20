/**
 * failure.ts (Phase 10 plan §5 "Failure clarity"). Renders an assertion
 * failure as a human-readable block — expected vs. actual status and a readable
 * golden diff — instead of a raw object dump. Used by the CLI's console summary
 * after a run; Phase 11's HTML report renders the same normalized fields.
 */
import type { SchemaDiffEntry } from "../../golden/src/compare.js";
import type { NormalizedStep, NormalizedTest } from "./collect.js";

/** One-line summary of a golden schema diff, or null when there is nothing to show. */
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

/** Render a single failing step into a readable multi-line block. */
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
    // Not a status mismatch (e.g. a thrown resolver error) — show the message,
    // trimmed to the first line so it stays readable.
    lines.push(`    error:    ${step.failure_message.split("\n")[0]}`);
  }
  return lines.join("\n");
}

/** Render all failures across a run into a readable report block. */
export function formatFailures(tests: NormalizedTest[]): string {
  const blocks: string[] = [];
  for (const test of tests) {
    if (test.status === "passed" || test.status === "skipped") continue;
    const failedSteps = test.steps.filter((s) => s.status === "failed");
    if (failedSteps.length === 0) {
      // Test failed but no request step captured the failure (e.g. setup/register).
      blocks.push(`  ✗ ${test.persona} / ${test.flow_name}\n    (test failed before any request step; see Playwright HTML report)`);
      continue;
    }
    for (const step of failedSteps) {
      blocks.push(formatStepFailure(test, step));
    }
  }
  return blocks.join("\n\n");
}
