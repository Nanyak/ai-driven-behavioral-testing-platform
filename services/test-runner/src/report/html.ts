import type { FailureEntry, GoldenDiffSummary, Report, ValueViolation } from "./schema.js";
import { computeFailureId } from "../triage/id.js";
import type { TriageReport, TriageVerdict } from "../triage/types.js";

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The golden-oracle cell shows both shape/type drift (schemaDiff) AND Tier A
// value-level violations (ADR 0001). value_diff is omitted unless rules fired,
// so reports without a value regression render byte-identically to before.
function goldenDiffHtml(diff: GoldenDiffSummary | null, valueDiff?: ValueViolation[]): string {
  const parts: string[] = [];
  if (diff) {
    for (const p of diff.missing) parts.push(`<span class="diff missing">− ${esc(p)}</span>`);
    for (const p of diff.unexpected) parts.push(`<span class="diff unexpected">+ ${esc(p)}</span>`);
    for (const p of diff.type_changed) parts.push(`<span class="diff changed">~ ${esc(p)}</span>`);
  }
  for (const v of valueDiff ?? []) {
    parts.push(`<span class="diff value">≠ ${esc(v.path)}: ${esc(v.actual)} (want ${esc(v.expected)})</span>`);
  }
  return parts.length ? parts.join("<br>") : '<span class="muted">—</span>';
}

function statusCell(expected: number | null, actual: number | null): string {
  if (expected === null && actual === null) return '<span class="muted">—</span>';
  return `<span class="exp">${esc(expected ?? "?")}</span> → <span class="act">${esc(actual ?? "?")}</span>`;
}

function provenanceHtml(f: FailureEntry): string {
  const sessions = f.source_sessions.length ? f.source_sessions.map(esc).join(", ") : "—";
  const trace = f.trace_id ? ` · trace ${esc(f.trace_id)}` : "";
  return `${esc(sessions)}${trace}`;
}

function triageChipHtml(v: TriageVerdict | undefined): string {
  if (!v) return '<span class="muted">—</span>';
  const label = v.verdict.replace(/_/g, " ");
  const title = esc(`${v.rationale} — ${v.recommended_action}`);
  return `<span class="chip ${esc(v.verdict)}" title="${title}">${esc(label)} · ${esc(v.confidence)}</span>`;
}

export function renderHtml(report: Report, triage?: TriageReport | null): string {
  // Advisory verdicts keyed by the deterministic failure id, so each failure
  // row can show its triage chip. Absent triage -> the column is not rendered
  // and the report is byte-for-byte the runner's original (gate-safe).
  const verdictById = new Map<string, TriageVerdict>();
  if (triage) for (const v of triage.verdicts) verdictById.set(v.failure_id, v);
  const hasTriage = Boolean(triage);
  const { totals } = report;
  const top = report.endpoint_failures[0];

  const personaRows = report.by_persona
    .map(
      (p) =>
        `<tr><td>${esc(p.persona)}</td><td class="num pass">${p.passed}</td><td class="num fail">${p.failed}</td><td class="num skip">${p.skipped}</td></tr>`,
    )
    .join("");

  const flowRows = report.by_flow
    .map(
      (f) =>
        `<tr><td>${esc(f.flow_name)}</td><td>${esc(f.persona)}</td><td class="num pass">${f.passed}</td><td class="num fail">${f.failed}</td><td class="num skip">${f.skipped}</td></tr>`,
    )
    .join("");

  const triageCol = hasTriage ? "<th>Triage</th>" : "";
  const failureRows = report.failures.length
    ? report.failures
        .map((f) => {
          const triageCell = hasTriage
            ? `\n        <td>${triageChipHtml(verdictById.get(computeFailureId(f)))}</td>`
            : "";
          return `<tr>
        <td>${esc(f.persona)}</td>
        <td>${esc(f.flow_name)}</td>
        <td class="mono">${esc(f.endpoint)}</td>
        <td class="mono">${statusCell(f.expected_status, f.actual_status)}</td>
        <td class="mono">${goldenDiffHtml(f.golden_diff, f.value_diff)}</td>${triageCell}
        <td class="mono small">${provenanceHtml(f)}</td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="${hasTriage ? 7 : 6}" class="muted center">No failures — all executed tests passed.</td></tr>`;

  const topCallout = top
    ? `<div class="callout fail-bg">Most-failing endpoint: <span class="mono">${esc(top.endpoint)}</span> — ${top.failures} failure(s)</div>`
    : "";

  const banner = report.status === "green" ? "green" : "red";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Regression Report — ${esc(report.run_id)}</title>
<style>
  :root { --pass:#15803d; --fail:#b91c1c; --skip:#a16207; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: var(--ink); margin: 0; background: #f8fafc; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .banner { display:inline-block; padding: 6px 14px; border-radius: 999px; font-weight: 700; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: #fff; }
  .banner.green { background: var(--pass); }
  .banner.red { background: var(--fail); }
  .totals { display:flex; gap: 12px; margin: 18px 0; flex-wrap: wrap; }
  .stat { background:#fff; border:1px solid var(--line); border-radius: 14px; padding: 14px 18px; min-width: 96px; }
  .stat .n { font-size: 26px; font-weight: 700; }
  .stat .l { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .stat.pass .n { color: var(--pass); } .stat.fail .n { color: var(--fail); } .stat.skip .n { color: var(--skip); }
  .callout { margin: 14px 0; padding: 12px 16px; border-radius: 12px; font-weight: 600; font-size: 14px; }
  .fail-bg { background:#fef2f2; border:1px solid #fecaca; color: var(--fail); }
  h2 { font-size: 15px; margin: 28px 0 10px; }
  table { width:100%; border-collapse: collapse; background:#fff; border:1px solid var(--line); border-radius: 12px; overflow: hidden; font-size: 13px; }
  th, td { text-align:left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { background:#f1f5f9; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pass { color: var(--pass); } .fail { color: var(--fail); } .skip { color: var(--skip); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .small { font-size: 11px; color: var(--muted); }
  .muted { color: var(--muted); } .center { text-align:center; }
  .exp { color: var(--muted); } .act { color: var(--fail); font-weight: 700; }
  .diff.missing { color: var(--fail); } .diff.unexpected { color: var(--skip); } .diff.changed { color: #7c3aed; }
  .diff.value { color: #be123c; font-weight: 600; }
  .chip { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; cursor: help; }
  .chip.real_regression { background:#fef2f2; color: var(--fail); border:1px solid #fecaca; }
  .chip.contract_drift { background:#fffbeb; color: var(--skip); border:1px solid #fde68a; }
  .chip.test_artifact { background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; }
  .chip.uncertain { background:#f1f5f9; color: var(--muted); border:1px solid var(--line); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Regression Report <span class="banner ${banner}">${esc(report.status)}</span></h1>
  <div class="sub">${esc(report.run_id)} · generated ${esc(report.generated_at)}</div>

  <div class="totals">
    <div class="stat"><div class="n">${totals.executed}</div><div class="l">Executed</div></div>
    <div class="stat pass"><div class="n">${totals.passed}</div><div class="l">Passed</div></div>
    <div class="stat fail"><div class="n">${totals.failed}</div><div class="l">Failed</div></div>
    <div class="stat skip"><div class="n">${totals.skipped}</div><div class="l">Skipped</div></div>
  </div>

  ${topCallout}

  <h2>By persona</h2>
  <table><thead><tr><th>Persona</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Skipped</th></tr></thead>
  <tbody>${personaRows || '<tr><td colspan="4" class="muted center">No tests.</td></tr>'}</tbody></table>

  <h2>By flow</h2>
  <table><thead><tr><th>Flow</th><th>Persona</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Skipped</th></tr></thead>
  <tbody>${flowRows || '<tr><td colspan="5" class="muted center">No flows.</td></tr>'}</tbody></table>

  <h2>Failures</h2>
  <table><thead><tr><th>Persona</th><th>Flow</th><th>Endpoint</th><th>Status (exp→act)</th><th>Golden diff</th>${triageCol}<th>Source session(s)</th></tr></thead>
  <tbody>${failureRows}</tbody></table>
</div>
</body>
</html>`;
}
