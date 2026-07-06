# Storage Migration Plans

Persistence design for hosting the platform on infrastructure with an **ephemeral
filesystem** (serverless / multi-replica containers, where a redeploy or reschedule
wipes anything written at runtime).

## Why

Today every pipeline stage reads and writes files under `REPO_ROOT`:

- `data/hitl/approvals.json`, `data/hitl/dismissed-relationships.json`, `data/hitl/approved-specs/`
- `services/behavior-engine/data/candidates/test-candidates-<runId>.json`
- `generated-tests/**/*.spec.ts`, `generated-tests/.artifacts.json`
- `reports/report.{html,json}`, `reports/runs/<runId>.{html,json}`, `reports/resolver-repair.json`

This is correct for a single-instance deployment with a persistent volume. It stops
working the moment the host gives you an ephemeral disk. These plans externalize the
durable state without fighting the pipeline architecture.

## Architectural constraints (why the design is what it is)

1. **Stages are separate OS processes.** `apps/platform-dashboard/server/jobs.ts`
   spawns each stage with `spawn("npm", ["run", "behavior:mine"], { cwd: REPO_ROOT })`.
   They communicate **only through the shared filesystem**.
2. **`approvals.json` has three readers in three processes**: the dashboard
   (`hitl-store.ts`), the miner (`behavior-engine/src/selection/coverage.ts` →
   `fromHitlStore`), and the generator (`script-generator/src/run.ts`). This
   cross-process read is the crux of the migration.
3. **Playwright must execute specs from a real filesystem.** The object store can be
   the source of truth, but a scratch workspace on disk is unavoidable at run time.

## Target shape — a hybrid

- The **long-lived dashboard** talks to the store *directly* through a `Storage`
  interface.
- The **short-lived spawned stages** stay file-based. `jobs.ts` **hydrates** their
  inputs to a scratch filesystem before `spawn` and **persists** their outputs after.

```
durable store (Postgres + S3)  ──hydrate──▶  scratch FS  ──run stage──▶  scratch FS  ──persist──▶  durable store
```

## Plans

| Plan | File | What | Status |
|------|------|------|--------|
| 1 | [`01-storage-abstraction.md`](01-storage-abstraction.md) | Pluggable `Storage` interface, `LocalFs` backend, wire all stages | ✅ done |
| 2 | [`02-postgres-records.md`](02-postgres-records.md) | Postgres backend for decisions / dismissed / run-index / manifest | ✅ done |
| 3 | [`03-object-store-artifacts.md`](03-object-store-artifacts.md) | MinIO/S3 backend for specs, reports, candidates | ✅ done |
| 4 | [`04-pipeline-data-plane.md`](04-pipeline-data-plane.md) | Remaining pipeline data (sessions, goldens, invariants, digests, triage), incremental invariants table, raw-log capture, operational hardening | ✅ done |

**Sequence: 1 → 2 → 3 → 4.** Plans 1–3 externalized the review/decision/spec/report
surface. Plan 4 closes the rest of the pipeline's durable state and hardens the
deployment, reusing the Plan 1 interface and the Plan 2/3 backends.

## One-paragraph summary

> Persistence is behind a `Storage` interface with a `LocalFs` backend for
> development and a `Postgres + S3` backend for production. Structured decisions and
> the audit trail live in Postgres (append-only, queryable, transactional); generated
> specs and reports are artifacts in object storage, hydrated to an ephemeral per-run
> workspace for the Playwright runner and persisted back on completion — so the
> pipeline is stateless and scales horizontally across workers.

## Operating it

Local development remains the default:

```bash
STORAGE_BACKEND=local npm run dashboard:dev
```

For the durable backend, start PostgreSQL and MinIO, migrate/import once, then run
the dashboard with `STORAGE_BACKEND=remote`:

```bash
docker compose up -d platform-postgres minio minio-init
export DATABASE_URL=postgres://platform:platform@localhost:5433/behavior_platform
export MINIO_ENDPOINT=http://localhost:9100
export MINIO_ROOT_USER=minioadmin
export MINIO_ROOT_PASSWORD=minioadmin
npm run storage:migrate
npm run storage:import-local
STORAGE_BACKEND=remote npm run dashboard:dev
```

When commands run on the host, `DATABASE_URL` and `MINIO_ENDPOINT` must use host
addresses (normally `localhost:5432` and `localhost:9100`). Docker Compose injects
the service-network addresses automatically for `platform-dashboard`.

Verification commands:

```bash
npm run storage:test
npm --prefix packages/storage run test:integration
```

The Compose stack keeps the Medusa SUT database (`postgres`) and platform metadata
database (`platform-postgres`) on separate services and volumes. For local retained
backups, start the `platform-db-backup` and `object-store-backup` services with the
`backups` profile; they write daily Postgres dumps and timestamped MinIO mirrors
with `BACKUP_RETENTION_DAYS` retention. Hosted
deployments should additionally enable provider-managed snapshots for both stores.
Raw Medusa traffic is shipped by Filebeat/Logstash to Elasticsearch; Compose
automatically installs the index template and a seven-day ILM retention policy.
Sessions and goldens derived by ingest remain durable in MinIO after raw indices expire.
