# Project Analysis Snapshot

## Scope

Report topic: "He thong tu dong hoa kiem thu Backend dua tren phan tich hanh vi nguoi dung".

The current repo implements an API/backend regression-testing PoC around a Medusa e-commerce REST API. The core pipeline is:

`Medusa logging middleware -> Filebeat/Logstash/Elasticsearch -> log-ingestion -> behavior-engine -> script-generator -> Playwright API test-runner -> reports/dashboard`.

The project is API-focused. Generated Playwright tests use request context and do not launch a browser.

## Repo Modules Read

- `README.md`
- `package.json`
- `docker-compose.yml`
- `apps/medusa/apps/backend/src/api/middlewares.ts`
- `apps/medusa/apps/backend/src/api/body-redaction.ts`
- `services/log-ingestion/src/pipeline.ts`
- `services/log-ingestion/src/types.ts`
- `services/behavior-engine/src/run.ts`
- `services/script-generator/src/run.ts`
- `services/golden/src/compare.ts`
- `services/test-runner/src/cli.ts`
- `services/test-runner/src/report/build.ts`
- `services/traffic-generator/src/orchestration/run.ts`
- `services/traffic-generator/src/config/taxonomy.ts`
- `packages/storage/index.ts`
- `packages/storage/postgres.ts`
- `packages/storage/s3.ts`
- `packages/storage/migrations/*.sql`

## Implemented

- Structured logging middleware in Medusa.
- Sensitive-body reduction/masking for passwords, tokens, cookies, email, phone, card/payment/address-like data.
- ELK local ingestion path through Filebeat and Logstash.
- Session grouping, endpoint normalization, retry/cache/noise filtering.
- Behavior mining using n-gram baseline, PrefixSpan, Markov support, deterministic persona classification, ranking, deduplication and skip gate.
- Error-path mining for recurring first-failure prefixes.
- Playwright API spec generation with persona/path routing.
- Golden oracle based on OpenAPI/observed schema, ignore fields, value rules and deterministic comparator.
- Test runner with normalized JSON, HTML/JSON report and green/red/invalid status.
- HITL/dashboard storage through PostgreSQL records and MinIO/S3 blobs.

## Demo/PoC

- Traffic source is synthetic/demo traffic, not production traffic.
- ELK is a local single-node setup.
- Medusa is the backend case study/system under test.
- LLM is used for traffic variation, naming, hints or advisory triage; pass/fail remains deterministic.
- Mutation evaluation exists. The latest all-target mutation run generated 150 mutants: 40 killed, 5 survived, 105 inconclusive, with mutation score 88.9% on the 45 measurable mutants and a clean baseline.

## PostgreSQL Snapshot

Source: running `platform-postgres` container, database `behavior_platform`.

- Tables: `decisions`, `dismissed_relationships`, `invariants`, `manifest`, `run_index`, `storage_metadata`, `storage_migrations`.
- Active decisions: 9, all `approved`.
- Run index rows: 11.
- Manifest rows: 10.
- Invariants: 295 rows, 113 verified and 182 unverified.
- Migrations applied: `0001_init.sql`, `0002_invariants.sql`.

## MinIO Snapshot

Source: running `minio` container, bucket `platwright`.

- `approved-specs`: 9 objects.
- `candidates`: 1 object.
- `endpoint-behavior`: 6 objects.
- `goldens`: 56 objects.
- `reports`: 33 objects.
- `sessions`: 1 object.
- `specs`: 29 objects.
- `validation`: 1 object.

Latest report from MinIO:

- `run_id`: `run-2026-07-07-104122`.
- Status: `green`.
- Totals: 9 executed, 9 passed, 0 failed, 0 skipped.

Latest mutation evaluation from MinIO:

- Generated at: `2026-07-07T18:39:25.188Z`.
- Target: `all`.
- Baseline: clean; executability rate: 100%.
- Mutants: 150 total, 40 killed, 5 survived, 105 inconclusive.
- Mutation score: 88.9% on measurable mutants.

Candidate run from MinIO:

- `run_id`: `2026-07-07T01-30-53-137Z`.
- Candidates: 18.
- `min_support`: 3.
- PrefixSpan patterns: 127764.
- n-gram patterns: 189.
- Persona counts: guest_shopper=3, registered_customer=10, admin_operator=5.
- Holdout recovered with support=6/floor=6.
- Negative control passed.
