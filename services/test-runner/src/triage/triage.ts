/**
 * Triage orchestrator. Reads the deterministic report + normalized run, builds
 * evidence, classifies each unique failure (LLM or offline heuristic), and
 * writes the SIDECAR reports/triage.json (+ per-run archive). It then re-renders
 * report.html with the verdict column merged in — report.json itself is never
 * touched, so the Phase 12 gate stays byte-stable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { NormalizedRunResult } from "../collect.js";
import { renderHtml } from "../report/html.js";
import type { Report } from "../report/schema.js";
import { buildEvidence, type AugmentedSpecs } from "./evidence.js";
import { triageAll } from "./llm.js";
import type { TriageReport } from "./types.js";

/** Unique-by-failure_id, preserving report order, so each distinct failure is triaged once. */
function dedupeById<T extends { failure_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.failure_id)) continue;
    seen.add(item.failure_id);
    out.push(item);
  }
  return out;
}

export async function runTriage(
  report: Report,
  normalized: NormalizedRunResult | null,
  specs: AugmentedSpecs | null,
  now: Date = new Date(),
): Promise<TriageReport> {
  const evidence = dedupeById(buildEvidence(report, normalized, specs));
  const { verdicts, model } = await triageAll(evidence);
  return {
    run_id: report.run_id,
    generated_at: now.toISOString(),
    model,
    verdicts,
  };
}

function runSlug(runId: string): string {
  const slug = runId.replace(/[^A-Za-z0-9._-]/g, "-");
  return slug.length > 0 ? slug : "run";
}

export interface WriteTriageResult {
  triageJsonPath: string;
  archiveJsonPath: string;
  htmlPath: string;
}

/**
 * Persist triage.json (+ archive) and re-render report.html (+ the per-run
 * archive html) with the verdicts merged. report.json is intentionally NOT
 * rewritten.
 */
export function writeTriage(
  report: Report,
  triage: TriageReport,
  reportsDir: string,
): WriteTriageResult {
  mkdirSync(reportsDir, { recursive: true });
  const triageJson = JSON.stringify(triage, null, 2);

  const triageJsonPath = resolvePath(reportsDir, "triage.json");
  writeFileSync(triageJsonPath, triageJson);

  const runsDir = resolvePath(reportsDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const slug = runSlug(report.run_id);
  const archiveJsonPath = resolvePath(runsDir, `${slug}.triage.json`);
  writeFileSync(archiveJsonPath, triageJson);

  // Re-render the canonical + archived HTML with the verdict column.
  const html = renderHtml(report, triage);
  const htmlPath = resolvePath(reportsDir, "report.html");
  writeFileSync(htmlPath, html);
  writeFileSync(resolvePath(runsDir, `${slug}.html`), html);

  return { triageJsonPath, archiveJsonPath, htmlPath };
}
