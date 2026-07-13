// Each run is ALSO archived under `reports/runs/<run_id>.{json,html}` so history
// accumulates instead of every run clobbering the single latest file. The
// canonical `report.json` / `report.html` remain the "latest" pointer (read by
// check:phase11/14 and the dashboard's /api/report).
import { mkdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { storage, type Storage } from "../../../../packages/storage/index.js";
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

export async function writeReports(
  result: NormalizedRunResult,
  reportsDir: string,
  opts: BuildOptions = {},
  store: Storage = storage,
): Promise<WriteReportsResult> {
  const report = buildReport(result, opts);

  const json = JSON.stringify(report, null, 2);
  const html = renderHtml(report);

  const jsonPath = resolvePath(reportsDir, "report.json");
  const htmlPath = resolvePath(reportsDir, "report.html");
  await mkdir(reportsDir, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, json, "utf8"),
    writeFile(htmlPath, html, "utf8"),
    store.blobs.put("reports/report.json", Buffer.from(json, "utf8")),
    store.blobs.put("reports/report.html", Buffer.from(html, "utf8")),
  ]);

  const runsDir = resolvePath(reportsDir, "runs");
  const slug = runSlug(report.run_id);
  const archiveJsonPath = resolvePath(runsDir, `${slug}.json`);
  const archiveHtmlPath = resolvePath(runsDir, `${slug}.html`);
  await mkdir(runsDir, { recursive: true });
  await Promise.all([
    writeFile(archiveJsonPath, json, "utf8"),
    writeFile(archiveHtmlPath, html, "utf8"),
    store.blobs.put(`reports/runs/${slug}.json`, Buffer.from(json, "utf8")),
    store.blobs.put(`reports/runs/${slug}.html`, Buffer.from(html, "utf8")),
  ]);
  const prior =
    (await store.records.readJson<{ entries?: Array<Record<string, unknown>> }>(
      "run-index"
    ))?.entries ?? [];
  const row = {
    run_id: report.run_id,
    slug,
    generated_at: report.generated_at,
    status: report.status,
    totals: report.totals,
  };
  const bySlug = new Map(
    prior
      .filter((entry) => typeof entry.slug === "string")
      .map((entry) => [entry.slug as string, entry])
  );
  bySlug.set(slug, row);
  await store.records.writeJson("run-index", {
    entries: [...bySlug.values()],
  });

  return { report, jsonPath, htmlPath, archiveJsonPath, archiveHtmlPath };
}
