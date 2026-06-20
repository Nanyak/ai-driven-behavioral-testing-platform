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

## Status — Implemented (scenario A), with a live-capture remainder

The two things the demo depends on are built and proven **offline**:

1. **Reversible injection** — `regressionDemoFault` in
   `apps/medusa/apps/backend/src/api/middlewares.ts`. OFF by default; when
   `REGRESSION_DEMO=carts_complete_500` is set it forces `POST /store/carts/{id}/complete`
   to return **500**. Registered *after* `requireCustomerAuth`, so only an
   authenticated customer reaches the fault — the failure is a behavioral
   regression, not an auth rejection. Flip the env var to go red→green with no
   redeploy. (Backend `tsc --noEmit` clean.)

2. **Detection + attribution** — proven by `npm run check:phase12` (9/9) against
   two committed normalized fixtures (`baseline-green` / `regressed-red`, same
   flow): the baseline builds a GREEN report; the regressed run builds a RED
   report attributing the failure to the right **persona** (`registered_customer`),
   **flow** (`Registered Customer Checkout`), and **endpoint**
   (`POST /store/carts/{id}/complete`, 200→500, source sessions cited), while the
   unaffected **guest** flow stays green — attribution is specific, not blanket.
   Rebuilding the baseline returns to green (reversibility).

### Live runbook (the remaining capture items)

Requires the running stack + a generated suite + frozen goldens:

```bash
# 1. Baseline green
npm run stack:core            # Medusa + deps + ELK
npm run traffic:generate && npm run ingest:run && npm run behavior:mine
npm run script-generator:generate
npm run test:all              # -> reports/report.json|html should be GREEN

# 2. Freeze goldens (do NOT re-ingest), then inject + re-run execution only
REGRESSION_DEMO=carts_complete_500 npm run medusa:dev   # restart backend with the toggle
npm run test:all              # -> report goes RED on POST /store/carts/{id}/complete

# 3. Revert: restart Medusa without the env var, re-run -> GREEN again.
```

Capture the red `report.html`, the 500 log lines, and the one-line middleware diff
for the Phase 13 writeup.
