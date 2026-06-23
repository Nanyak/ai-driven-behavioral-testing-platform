#!/usr/bin/env node
/**
 * `npm run triage` — post-run, advisory triage of the latest report.
 *
 * Decoupled from the test run (cli.ts) on purpose: it reads the durable
 * artifacts the runner already wrote (reports/report.json for attribution +
 * reports/playwright/normalized.json for the detailed diff and captured
 * response bodies), so it can be re-run and inspected in isolation without
 * re-executing Playwright. Writes reports/triage.json and re-renders
 * report.html with verdicts. Runs offline (heuristic) when no key is set.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadAugmentedSpecs } from "../../../golden/src/oas-source.js";
import type { NormalizedRunResult } from "../collect.js";
import type { Report } from "../report/schema.js";
import { REPO_REPORTS_DIR, REPORTS_DIR } from "../run.js";
import type { AugmentedSpecs } from "./evidence.js";
import { runTriage, writeTriage } from "./triage.js";

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function loadSpecs(): AugmentedSpecs | null {
  try {
    return loadAugmentedSpecs();
  } catch {
    // Augmented OAS not built (golden:build-oas not run). required-missing
    // simply stays empty; triage still classifies on status + diff shape.
    return null;
  }
}

async function main(): Promise<void> {
  const reportPath = resolvePath(REPO_REPORTS_DIR, "report.json");
  const report = readJson<Report>(reportPath);
  if (!report) {
    console.error(`No report found at ${reportPath}. Run \`npm run test:all\` first.`);
    process.exit(2);
  }

  const normalized = readJson<NormalizedRunResult>(resolvePath(REPORTS_DIR, "normalized.json"));
  const specs = loadSpecs();

  const triage = await runTriage(report, normalized, specs);
  const { triageJsonPath, htmlPath } = writeTriage(report, triage, REPO_REPORTS_DIR);

  console.log(`\nRegression Triage (${triage.model})`);
  if (triage.verdicts.length === 0) {
    console.log(report.status === "green" ? "  No failures to triage — report is green." : "  No failure entries found.");
  } else {
    const counts = new Map<string, number>();
    for (const v of triage.verdicts) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
    for (const [verdict, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${verdict.padEnd(16)} ${n}`);
    }
    console.log("\n  Top findings:");
    for (const v of triage.verdicts.slice(0, 5)) {
      console.log(`    [${v.verdict}/${v.confidence}] ${v.evidence.endpoint} — ${v.rationale}`);
    }
  }
  console.log(`\n  Triage (JSON): ${triageJsonPath}`);
  console.log(`  Report (HTML): ${htmlPath}`);
}

main().catch((err) => {
  console.error("triage failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
