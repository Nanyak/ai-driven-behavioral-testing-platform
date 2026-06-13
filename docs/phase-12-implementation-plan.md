# Phase 12 — Regression Demonstration

## Goal

Prove the whole pipeline does what it claims: introduce a controlled change in Medusa, re-run the generated tests against the unchanged golden baseline, and show the report correctly identifies the regression and attributes it to a persona, flow, and endpoint. This is the demo centerpiece.

## Approach

Run the pipeline once on a healthy backend to establish goldens and a green report, then inject exactly one regression and re-run **only execution + reporting** (not ingestion — the baseline must stay frozen, plan §11.3).

## Two regression scenarios (pick one to demo, ideally show both)

### A. Response-code regression
Introduce a change that makes a known endpoint return a different status — e.g. a middleware tweak or a deliberately broken validation on `POST /store/carts/{id}/complete` so it returns 500 instead of 200.

- Expected detection: status assertion fails; report shows `expected_status: 200, actual_status: 500`.

### B. Schema regression
Change a response body shape on a known endpoint — e.g. rename or drop a field in a custom route or subscriber that touches `GET /store/products` output.

- Expected detection: golden-schema comparison flags a missing/renamed field; status may still be 200, so this proves schema-level detection beyond status codes.

## Steps

1. **Baseline run.** Healthy Medusa → traffic → ingest → goldens → generate → execute → report. Confirm green.
2. **Freeze goldens.** Do not re-run ingestion after this point.
3. **Inject regression** (scenario A or B) in a clearly reversible way (feature flag, env toggle, or a small reverted-after commit).
4. **Re-run execution + reporting only.** `npm run test:all`.
5. **Confirm detection** in `report.json`/`report.html`:
   - the affected **endpoint** is listed under `endpoint_failures`
   - the affected **flow** shows a failure
   - the affected **persona** shows a failure
   - expected vs. actual status (A) or golden diff (B) is shown
   - the failure cites the source `session_id`/`trace_id`
6. **Revert** the regression and confirm the report returns to green.
7. **Capture artifacts.** Screenshots of the red report, the relevant log lines, and the diff of the injected change for documentation (Phase 13).

## Key decisions

- **One variable at a time** — a single injected change keeps attribution unambiguous.
- **Baseline frozen** — a schema change is a regression *because* the baseline wasn't refreshed; refreshing would mask it.
- **Reversible injection** — use a toggle so the demo can flip red→green live.

## Validation / acceptance

- A controlled regression is detected on re-run.
- The report identifies the affected persona, flow, and endpoint.
- Expected-vs-actual status (A) and/or golden diff (B) is shown.
- Reverting restores a green report.
- Screenshots/logs captured for the writeup.
