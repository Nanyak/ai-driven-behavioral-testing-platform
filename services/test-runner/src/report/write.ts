// Each run is ALSO archived under `reports/runs/<run_id>.{json,html}` so history
// accumulates instead of every run clobbering the single latest file. The
// canonical `report.json` / `report.html` remain the "latest" pointer (read by
// check:phase11/14 and the dashboard's /api/report).
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
  archiveJsonPath: string;
  archiveHtmlPath: string;
}

function runSlug(runId: string): string {
  const slug = runId.replace(/[^A-Za-z0-9._-]/g, "-");
  return slug.length > 0 ? slug : "run";
}

export function writeReports(
  result: NormalizedRunResult,
  reportsDir: string,
  opts: BuildOptions = {},
): WriteReportsResult {
  const report = buildReport(result, opts);
  mkdirSync(reportsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const html = renderHtml(report);

  const jsonPath = resolvePath(reportsDir, "report.json");
  const htmlPath = resolvePath(reportsDir, "report.html");
  writeFileSync(jsonPath, json);
  writeFileSync(htmlPath, html);

  const runsDir = resolvePath(reportsDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const slug = runSlug(report.run_id);
  const archiveJsonPath = resolvePath(runsDir, `${slug}.json`);
  const archiveHtmlPath = resolvePath(runsDir, `${slug}.html`);
  writeFileSync(archiveJsonPath, json);
  writeFileSync(archiveHtmlPath, html);

  return { report, jsonPath, htmlPath, archiveJsonPath, archiveHtmlPath };
}
