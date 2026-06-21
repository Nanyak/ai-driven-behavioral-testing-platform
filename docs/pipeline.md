# Pipeline — step-by-step run order

This is the operating manual for running the full pipeline against a live stack,
in order, with the command, what it produces, and how to confirm it worked. It is
the expanded form of the README quickstart and the basis for the Phase 14 clean
run (`docs/phase-14-implementation-plan.md`).

> Every stage also has an **offline** check (`npm run check:phaseN`) that proves
> the stage's logic against committed fixtures without the live stack. Run
> `npm run check:phase14` for the full offline sign-off. The steps below are the
> **live** path.

## 0. Install

```bash
npm install
npm install --prefix apps/medusa
npm install --prefix apps/storefront
npm install --prefix apps/platform-dashboard
cp .env.example .env     # set ANTHROPIC_API_KEY for LLM-varied traffic + naming
```

The deterministic mining/classification path does not need an API key; only
LLM-varied traffic and flow naming/anomaly/assertion calls do.

## 1. Start Medusa (Postgres + Redis) and seed

```bash
npm run compose:up
npm run medusa:setup        # seed products/regions/shipping/keys + admin user; writes MEDUSA_PUBLISHABLE_API_KEY into .env
docker-compose restart medusa
```

For the Phase 14 clean run, start Medusa with `LOG_CAPTURE_BODIES=true` so bodies
reach the logs for golden extraction (enrichment only — the OAS oracle works
bodies-off, ADR 0001).

**Confirm:** `GET http://localhost:9000/health` is healthy; `GET /store/products`
returns seeded products (with `x-publishable-api-key`); admin auth via
`POST /auth/user/emailpass` returns a token.

## 2. Start ELK and create the data view

```bash
npm run elk:up
```

One-time, in the Kibana UI (`http://localhost:5601`): **Stack Management → Data
Views → create `behavior-logs-*`** with time field `@timestamp`.

**Confirm:** the Elasticsearch cluster is green/yellow; the data view exists.

## 3. Generate synthetic traffic

```bash
npm run traffic:generate
```

Drives staged guest/customer/admin/edge traffic at real Medusa APIs. Sessions
carry `session_id`/`trace_id` only — no persona header.

**Confirm:** the run prints its observed-vs-target distribution and acceptance
gates (≥6 holdout checkouts, ≥5 linked refunds, floors met). The
registered-customer `register→login→checkout` sequence comes **only** from
`personas/customer-llm.ts`.

## 4. Verify logs in Kibana

In Kibana Discover, filter the `behavior-logs-*` view by `session_id`,
`user_role`, and `status` (and `event`/`service`).

**Confirm:** logs are grouped per session and span guest/customer/admin roles —
note there is **no** persona field (persona is emergent, derived in Phase 7).

## 5. Ingest logs into session flows + golden candidates

```bash
npm run ingest:run
```

Queries Elasticsearch, groups by `session_id`, sorts by `timestamp`, normalizes
dynamic URL segments (`/store/carts/cart_123` → `/store/carts/{id}`), drops noise,
and writes session-flow JSON + golden candidates under `golden-responses/`.

**Confirm:** ≥50 session-flow records; golden candidates produced (golden
extraction needs bodies-on data — `LOG_CAPTURE_BODIES=true` in step 1).

## 6. Mine behavior flows + emergent personas

```bash
npm run behavior:mine
```

Runs n-gram + PrefixSpan over the raw, unlabeled stream; derives personas
deterministically from endpoint content + status; dedups/clusters/ranks; applies
the cross-run skip gate; and writes `test-candidates-*.json` plus the
**classification/holdout/negative-control validation report**.

**Confirm:** ≥5 test candidates; the validation report shows per-persona
precision/recall vs. JWT `user_role`, the holdout checkout support count (≥6), and
a passing negative control.

## 7. Generate Playwright tests

```bash
npm run script-generator:generate
```

Reads the newest candidates, dedups/clusters/caps at ten per persona, resolves
IDs/tokens at runtime, adds status + golden assertions, and writes
`generated-tests/<persona>/<signature>.spec.ts`.

**Confirm:** ≥5 valid `.spec.ts`; `tsc --noEmit` and `playwright test --list` are
clean (both run by `npm run check:phase9`).

## 8. Execute the suite

```bash
npm run test:all
# or per persona: npm run test:guest | test:customer | test:admin | test:edge
```

Runs the suite against Medusa, captures Playwright JSON + HTML, and normalizes
into `reports/playwright/normalized.json`.

**Confirm:** a green baseline; failed assertions print expected-vs-actual status +
a readable golden diff.

## 9. Read the report

```bash
open reports/report.html      # also reports/report.json
```

Self-contained HTML (inline CSS/JS, no external assets). Includes totals, passed/
failed, `by_persona`, `by_flow` (keyed by flow signature), `endpoint_failures`
(most-failing endpoint), expected-vs-actual status, golden diff, and source
sessions.

## 10. Regression demo (Phase 12)

```bash
# inject: restart Medusa with the toggle on
REGRESSION_DEMO=carts_complete_500 docker-compose up -d medusa
npm run test:customer
open reports/report.html       # RED — POST /store/carts/{id}/complete 200→500,
                               # attributed to registered_customer / Checkout; guest stays green
# revert:
docker-compose up -d medusa    # toggle unset → next() → 200; re-run returns to green
```

The toggle is OFF by default and reversible by a single env var. Attribution is
specific: only the affected persona/flow/endpoint goes red.

## Command reference

| Stage | Command | Output |
| --- | --- | --- |
| Start Medusa | `npm run compose:up` + `npm run medusa:setup` | seeded backend on `:9000` |
| Start ELK | `npm run elk:up` | ES `:9200`, Kibana `:5601` |
| Traffic | `npm run traffic:generate` | logs in Elasticsearch |
| Ingest | `npm run ingest:run` | session flows + `golden-responses/` |
| Mine | `npm run behavior:mine` | `test-candidates-*.json` + validation report |
| Generate | `npm run script-generator:generate` | `generated-tests/**/*.spec.ts` |
| Execute | `npm run test:all` | `reports/playwright/normalized.json` |
| Report | (written by execute) | `reports/report.{json,html}` |
| Offline sign-off | `npm run check:phase14` | all phase logic verified vs. fixtures |
