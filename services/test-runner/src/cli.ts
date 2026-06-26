#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { collectFromFile, type NormalizedRunResult } from "./collect.js";
import { formatFailures } from "./failure.js";
import { formatReportSummary } from "./report/summary.js";
import { writeReports } from "./report/write.js";
import { PATH_FILTERS, PROJECTS, REPO_REPORTS_DIR, REPORTS_DIR, runPlaywright, type Target } from "./run.js";

const VALID_TARGETS: Target[] = ["all", ...PROJECTS, ...PATH_FILTERS];

function parseTarget(arg: string | undefined): Target {
  const t = (arg ?? "all").toLowerCase();
  if ((VALID_TARGETS as string[]).includes(t)) return t as Target;
  console.error(`Unknown target "${arg}". Use one of: ${VALID_TARGETS.join(", ")}`);
  process.exit(2);
}

function printSummary(result: NormalizedRunResult, target: Target): void {
  const { totals } = result;
  console.log(`\nTest Runner (${target})`);
  console.log(`  Executed: ${totals.executed}  Passed: ${totals.passed}  Failed: ${totals.failed}  Skipped: ${totals.skipped}`);

  const byPersona = new Map<string, { passed: number; failed: number; skipped: number }>();
  for (const t of result.tests) {
    const row = byPersona.get(t.persona) ?? { passed: 0, failed: 0, skipped: 0 };
    if (t.status === "passed") row.passed++;
    else if (t.status === "skipped") row.skipped++;
    else row.failed++;
    byPersona.set(t.persona, row);
  }
  for (const [persona, row] of byPersona) {
    console.log(`    ${persona.padEnd(22)} passed ${row.passed}  failed ${row.failed}  skipped ${row.skipped}`);
  }

  if (totals.failed > 0) {
    console.log(`\nFailures:`);
    console.log(formatFailures(result.tests));
  }
}

function main(): void {
  const target = parseTarget(process.argv[2]);

  const run = runPlaywright({ target });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  const result: NormalizedRunResult = existsSync(run.jsonReportPath)
    ? collectFromFile(run.jsonReportPath)
    : {
        generated_at: new Date().toISOString(),
        totals: { executed: 0, passed: 0, failed: 0, skipped: 0 },
        tests: [],
      };
  if (!existsSync(run.jsonReportPath)) {
    console.error("\nPlaywright did not produce a fresh JSON report; the run is INVALID.");
  }
  const normalizedPath = resolvePath(REPORTS_DIR, "normalized.json");
  writeFileSync(normalizedPath, JSON.stringify(result, null, 2));

  printSummary(result, target);

  const { report, jsonPath, htmlPath } = writeReports(result, REPO_REPORTS_DIR);
  console.log(`\n${formatReportSummary(report)}`);

  console.log(`\n  Playwright JSON:   ${run.jsonReportPath}`);
  console.log(`  Playwright HTML:   ${run.htmlReportDir}/index.html`);
  console.log(`  Normalized result: ${normalizedPath}`);
  console.log(`  Report (JSON):     ${jsonPath}`);
  console.log(`  Report (HTML):     ${htmlPath}`);

  const exitStatus = run.status !== 0 ? run.status : report.status === "invalid" ? 1 : 0;
  process.exit(exitStatus);
}

main();
