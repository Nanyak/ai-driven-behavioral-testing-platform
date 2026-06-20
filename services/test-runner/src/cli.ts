#!/usr/bin/env node
/**
 * cli.ts (Phase 10 plan step #3). Subcommands:
 *   all | guest | customer | admin | edge
 *
 * Each runs the Phase 9 generated Playwright suite for that persona project (or
 * all), writes JSON + HTML under reports/playwright/, then normalizes the JSON
 * (collect.ts) into the Phase 11 input shape, persisting it to
 * reports/playwright/normalized.json. Prints a readable pass/fail summary and a
 * clear expected-vs-actual + golden-diff block for any failures (plan §5).
 *
 *   npx tsx src/cli.ts guest
 *   npm run test:guest        (root package.json delegates here)
 */
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { collectFromFile, type NormalizedRunResult } from "./collect.js";
import { formatFailures } from "./failure.js";
import { PROJECTS, REPORTS_DIR, runPlaywright, type Target } from "./run.js";

const VALID_TARGETS: Target[] = ["all", ...PROJECTS];

function parseTarget(arg: string | undefined): Target {
  const t = (arg ?? "all").toLowerCase();
  if ((VALID_TARGETS as string[]).includes(t)) return t as Target;
  console.error(`Unknown target "${arg}". Use one of: ${VALID_TARGETS.join(", ")}`);
  process.exit(2);
}

function printSummary(result: NormalizedRunResult, target: Target): void {
  const { totals } = result;
  console.log(`\nPhase 10 — Test Runner (${target})`);
  console.log(`  Executed: ${totals.executed}  Passed: ${totals.passed}  Failed: ${totals.failed}  Skipped: ${totals.skipped}`);

  // Per-persona rollup, so a regression is attributable to guest vs customer vs admin.
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

  const result = collectFromFile(run.jsonReportPath);
  const normalizedPath = resolvePath(REPORTS_DIR, "normalized.json");
  writeFileSync(normalizedPath, JSON.stringify(result, null, 2));

  printSummary(result, target);
  console.log(`\n  JSON report:       ${run.jsonReportPath}`);
  console.log(`  HTML report:       ${run.htmlReportDir}/index.html`);
  console.log(`  Normalized result: ${normalizedPath}`);

  // Exit non-zero if Playwright reported failures, so CI/`npm run` surfaces it.
  process.exit(run.status);
}

main();
