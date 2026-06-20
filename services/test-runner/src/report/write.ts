/**
 * write.ts (Phase 11 plan step #5 wiring). Build the report from a normalized
 * run result and persist both `reports/report.json` and `reports/report.html`
 * to the repo-root reports/ directory. Returns the built report so the caller
 * can print the console summary.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { NormalizedRunResult } from "../collect.js";
import { buildReport, type BuildOptions } from "./build.js";
import { renderHtml } from "./html.js";
import type { Report } from "./schema.js";

export interface WriteReportsResult {
  report: Report;
  jsonPath: string;
  htmlPath: string;
}

/** Build + write report.json and report.html into `reportsDir`. */
export function writeReports(
  result: NormalizedRunResult,
  reportsDir: string,
  opts: BuildOptions = {},
): WriteReportsResult {
  const report = buildReport(result, opts);
  mkdirSync(reportsDir, { recursive: true });

  const jsonPath = resolvePath(reportsDir, "report.json");
  const htmlPath = resolvePath(reportsDir, "report.html");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(htmlPath, renderHtml(report));

  return { report, jsonPath, htmlPath };
}
