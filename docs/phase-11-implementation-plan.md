# Phase 11 — Reporting

## Goal

Produce stakeholder-facing regression reports from the normalized run results: a machine-readable `report.json` and a human-readable `report.html`, each attributing failures to persona, flow, and endpoint, and tracing every test back to the production session that produced it.

## Location

```
services/test-runner/            # reporting lives alongside execution
  src/
    report/
      schema.ts          # report JSON schema/types
      build.ts           # run result -> report.json
      html.ts            # report.json -> report.html (self-contained)
      summary.ts         # console summary
reports/
  report.json
  report.html
```

## Report JSON schema (top level)

```json
{
  "run_id": "run-2026-06-13-001",
  "generated_at": "2026-06-13T11:00:00Z",
  "totals": { "executed": 12, "passed": 10, "failed": 2 },
  "by_persona": [
    { "persona": "guest_shopper", "passed": 5, "failed": 0 },
    { "persona": "registered_customer", "passed": 3, "failed": 1 },
    { "persona": "admin_operator", "passed": 2, "failed": 1 }
  ],
  "by_flow": [
    { "flow_name": "...", "persona": "...", "passed": 2, "failed": 1 }
  ],
  "endpoint_failures": [
    { "endpoint": "POST /store/carts/{id}/complete", "failures": 2 }
  ],
  "failures": [
    {
      "flow_name": "...",
      "persona": "registered_customer",
      "endpoint": "POST /store/carts/{id}/complete",
      "expected_status": 200,
      "actual_status": 500,
      "golden_diff": { "missing": [], "unexpected": ["error"], "type_changed": [] },
      "duration_ms": 142,
      "source_session_id": "sess-...",
      "source_trace_id": "trace-..."
    }
  ]
}
```

## Implementation steps

1. **Types/schema (`schema.ts`).** Encode the structure above.
2. **Build (`build.ts`).** Aggregate the Phase 10 normalized result into totals, per-persona, per-flow, and endpoint-failure rollups; attach golden diffs and provenance to each failure.
3. **HTML (`html.ts`).** Render a single self-contained `report.html` (inline CSS, no server) with: a summary header, a per-persona table, a failures table with expandable golden diffs, and a "most-failing endpoint" callout. Keep it openable by double-click.
4. **Console summary (`summary.ts`).** Print pass/fail totals and the top failing endpoint after a run.
5. **Wire into the runner** so `npm run test:all` ends by writing both report files.

## Required fields (acceptance, from plan §13)

- total tests executed; passed/failed counts
- persona-level results
- flow-level results
- endpoint-level failures
- expected vs. actual status code
- golden response diff
- source `session_id` and `trace_id`

## Validation / acceptance

- `reports/report.json` and `reports/report.html` are generated after a run.
- `report.html` opens locally and renders the summary, per-persona, and failures tables.
- Every failure entry cites persona, flow, endpoint, expected/actual status, golden diff, and source session/trace IDs.
- Console prints a readable summary.

## Status — Implemented

Built in `services/test-runner/src/report/`: `schema.ts` (types + `summarizeGoldenDiff`),
`build.ts` (`buildReport` — deterministic aggregation), `html.ts` (`renderHtml` —
single self-contained file), `summary.ts` (`formatReportSummary`), and `write.ts`
(`writeReports` → `reports/report.json` + `reports/report.html`). Wired into
`src/cli.ts`: every `npm run test:*` run ends by writing both files and printing a
red/green summary. `run.ts` exports `REPO_REPORTS_DIR`.

Design notes:
- The report's `totals` carry `skipped` through from the Phase 10 normalized result
  (≈20 specs are `test.fixme`), so `executed = passed + failed + skipped` reconciles —
  the plan's example omitted it.
- `golden_diff` is the plan's rolled-up `{ missing, unexpected, type_changed }` path
  lists; the full expected/actual detail stays in the normalized result.
- `by_flow` is keyed by the ADR 0002 flow signature when present (persona-independent
  identity), falling back to persona+name.
- `trace_id` is omitted from a failure entry unless an upstream annotation supplies one
  (never invented) — consistent with the Phase 10 contract.

Verified offline by `npm run check:phase11` (10/10): tsc clean, rollups + failure
fields aggregated from the committed normalized fixture, both report files written,
`report.html` confirmed self-contained (no `<link>`/`<script>`).
