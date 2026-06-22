import type { Report } from "./schema.js";

export function formatReportSummary(report: Report): string {
  const { totals } = report;
  const lines: string[] = [];
  const verdict = report.status === "green" ? "GREEN ✓" : "RED ✗";
  lines.push(`Regression report: ${verdict}  (${report.run_id})`);
  lines.push(`  Executed ${totals.executed}  Passed ${totals.passed}  Failed ${totals.failed}  Skipped ${totals.skipped}`);

  const top = report.endpoint_failures[0];
  if (top) {
    lines.push(`  Most-failing endpoint: ${top.endpoint} (${top.failures})`);
  }

  if (report.failures.length) {
    lines.push(`  Failures:`);
    for (const f of report.failures) {
      const status =
        f.expected_status !== null || f.actual_status !== null
          ? `  [${f.expected_status ?? "?"}→${f.actual_status ?? "?"}]`
          : "";
      lines.push(`    ✗ ${f.persona} / ${f.flow_name} — ${f.endpoint}${status}`);
    }
  }
  return lines.join("\n");
}
