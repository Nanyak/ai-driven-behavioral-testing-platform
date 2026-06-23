# Pipeline runbook

The exact run order from a clean checkout to a green regression report, then how
to catch a regression end to end. Each stage has one command and writes one
artifact the next stage reads. For the component breakdown see
[`architecture.md`](./architecture.md); for scope caveats see
[`limitations.md`](./limitations.md).

## Prerequisites

- Node.js 20+, npm 10+, Docker + `docker-compose`.
- `ANTHROPIC_API_KEY` (only for LLM-varied traffic + flow naming/anomaly/assertion
  enrichment). **Mining and classification are deterministic and need no key.**

## Stage order

| # | Stage | Command | Produces | Acceptance gate |
| --- | --- | --- | --- | --- |
| 0 | Install deps | `npm install` (+ per-app installs) | `node_modules` | `npm run check:phase0` |
| 1 | Start core + seed | `npm run compose:up` → `npm run medusa:setup` → `docker-compose restart medusa` | Medusa + Postgres + Redis, seeded | Medusa health `200`; `check:phase1` |
| 2 | Start ELK | `npm run elk:up` | Elasticsearch / Logstash / Kibana | `check:phase3`, `check:phase4` |
| 3 | Generate traffic | `npm run traffic:generate` | Logged requests in Elasticsearch | `check:phase5` |
| 4 | Ingest logs | `npm run ingest:run` | `data/sessions/session-flows-*.json` + golden candidates | `check:phase6` |
| 5 | Mine behavior | `npm run behavior:mine` | Test candidates + `classification-report-<runId>.json` | `check:phase7` |
| 6 | Generate tests | `npm run script-generator:generate` | `generated-tests/**/*.spec.ts` | `check:phase9` |
| 7 | Run suite | `npm run test:all` | `reports/report.{json,html}` | `check:phase10`, `check:phase11` |
| 8 | Read report | `open reports/report.html` | — | report is **green** |

## Clean checkout → green report (copy/paste)

```bash
# 0. Install root + service/app deps
npm install
npm install --prefix apps/medusa
npm install --prefix apps/storefront
npm install --prefix apps/platform-dashboard
cp .env.example .env            # set ANTHROPIC_API_KEY for LLM-varied traffic

# 1. Start Medusa + Postgres + Redis, then seed and restart to pick up schema
npm run compose:up
npm run medusa:setup            # seed products/regions/keys + admin user
docker-compose restart medusa

# 2. Start ELK, then create the Kibana behavior-logs-* data view (one-time, in the UI)
npm run elk:up

# 3. Drive synthetic traffic at Medusa
npm run traffic:generate

# 4. Reconstruct session flows + golden candidates from Elasticsearch
npm run ingest:run

# 5. Mine behavior flows + emergent personas (writes candidates + validation report)
npm run behavior:mine

# 6. Generate Playwright API tests from the candidates
npm run script-generator:generate

# 7. Execute the generated suite against Medusa
npm run test:all

# 8. Read the report
open reports/report.html
```

### Per-persona runs

```bash
npm run test:guest      # guest_shopper specs only (both subfolders)
npm run test:customer   # registered_customer specs only (both subfolders)
npm run test:admin      # admin_operator specs only (both subfolders)
npm run test:happy      # happy-path specs across all personas
npm run test:failure    # failure-path (has_errors) specs across all personas
```

## Regression demo (catch a regression end to end)

The headline demo: an AI-generated test catches a real, injected regression.

```bash
# 1. Confirm green
npm run test:customer            # report green

# 2. Inject the regression and restart the SUT
#    REGRESSION_DEMO=carts_complete_500 makes POST /store/carts/{id}/complete fail
docker-compose up -d --build     # with REGRESSION_DEMO set in the Medusa env
npm run test:customer            # report goes RED, attributed to persona/flow/endpoint

# 3. Revert and re-run
#    unset REGRESSION_DEMO, restart Medusa
npm run test:customer            # back to green
```

The red report attributes the failure down to the persona, the mined flow, and the
exact endpoint — demonstrating that the generated test, not a hand-written one,
caught the break.

## Offline verification (no live stack)

Every phase ships a fixture-backed check that proves its logic without the running
stack — mining, golden comparison, report build, and regression
detection/attribution all run against committed fixtures.

```bash
npm run check:phase0    # project setup            npm run check:phase8   # golden / OAS oracle
npm run check:phase1    # Medusa API + seed        npm run check:phase9   # script generator
npm run check:phase2    # logging middleware       npm run check:phase10  # test execution
npm run check:phase3    # ELK ingestion            npm run check:phase11  # reporting
npm run check:phase4    # log schema + Kibana      npm run check:phase12  # regression demo
npm run check:phase5    # traffic generator        npm run check:phase14  # offline sign-off chain
npm run check:phase6    # log ingestion            npm run check:phase15  # HITL review dashboard
npm run check:phase7    # behavioral modeling

# Traffic generator must always compile clean (hard gate):
cd services/traffic-generator && npx tsc --noEmit
```

`npm run check:phase14` chains the fixture-backed sign-off in order (phases
0/2/3/6–12/15). The live-stack probes (1/4/5) are excluded — they run during the
clean end-to-end run above.

## Re-running a single stage

Because stages are decoupled through files, any stage can be re-run in isolation:

- Re-mine without re-ingesting: `npm run behavior:mine` (reads the newest
  `data/sessions/session-flows-*.json`).
- Re-generate tests without re-mining: `npm run script-generator:generate`.
- Re-run the suite without re-generating: `npm run test:all`.

## Troubleshooting

- **Dashboard shows zeros after a compose change** — the dashboard runs in Docker;
  a stale container can miss new mounts. Force-recreate it.
- **LLM silently using the offline fallback** — an empty exported
  `ANTHROPIC_API_KEY` shadows the key. Put a real key in
  `services/behavior-engine/.env` (gitignored) or unset the blank shell var.
- **ELK memory pressure** — Elasticsearch is single-node and laptop-bound; close
  other heavy containers if ingestion stalls.
