# Plan 4 — Pipeline data plane + operational hardening

**Status:** complete
**Depends on:** Plans 1–3 (the `Storage` interface, Postgres backend, MinIO backend — all complete)

## Goal

Plans 1–3 externalized the review/decision/spec/report surface. Plan 4 closes the
**rest of the pipeline's durable state** — the artifacts that flow *into* and *between*
mine/generate (sessions, goldens, invariants, endpoint-behavior digests, triage) — and
hardens the deployment (raw-log capture across containers, runner dependencies,
bootstrap, multi-replica locking). It reuses the existing `Storage` interface and the
Postgres/MinIO backends; no new backend is introduced.

## Part A — Remaining data-plane artifacts

Route these through the existing backends. Classification (who writes → reads, and home):

| Artifact | Written by → read by | Home | Logical key / table |
|---|---|---|---|
| `data/sessions/session-flows-*.json` | ingest → miner | **MinIO** | `sessions/session-flows-<runId>.json` |
| `golden-responses/*.json` | ingest → generate | **MinIO** | `goldens/<name>.json` |
| `data/endpoint-behavior/*.md` | invariants → invariants | **MinIO** | `endpoint-behavior/<slug>.md` (LLM cache) |
| `reports/*.triage.json` | triage → dashboard | **MinIO** | `reports/runs/<slug>.triage.json` |
| `data/invariants/invariants.json` | invariants → generate | **Postgres** | `invariants` table (Part B) |

### Do NOT externalize (these are code or build output, not runtime state)

- **`generated-tests/_golden`** — the golden-verification **library** (`services/golden/src`
  vendored into the workspace so specs can `import` it). Bakes with the runner image /
  vendored at generate time. **Not** the same as `golden-responses/` (oracle data).
- **Augmented OAS** (`services/golden/openapi/build-oas.ts` → `store.json`/`admin.json`) —
  build artifact, baked into the image.
- **`.env` / config readers** — become **env vars**, not files.

### Hydrate/persist wiring (in `jobs.ts`, extending Plan 3)

- `ingest` → query **Elasticsearch** for raw logs (Part C); persist `sessions/`, `goldens/`.
- `mine` → hydrate `sessions/`.
- `generate` → hydrate `goldens/`, `invariants` (Postgres).
- `invariants:propose` → hydrate `endpoint-behavior/`; persist `endpoint-behavior/` + `invariants` rows.
- `invariants:verify` → **hydrate the latest `reports/playwright/normalized.json` from MinIO**
  (it is the verify input); update `invariants` rows. Sequencing dependency — see Risks.
- `triage` → persist `reports/runs/<slug>.triage.json`.

## Part B — Invariants as an incremental Postgres table

Replaces the whole-file `invariants.json` override with a per-invariant table, so
propose and verify stop clobbering each other. **Grain: one row per invariant.**

```sql
create table invariants (
  id             text primary key,        -- deterministic identity (see below)
  flow_signature text not null,
  flow_name      text,
  cache_key      text,                     -- gates re-proposal (hash of prompt inputs)
  step_title     text not null,
  source         text not null,            -- ai-proposed | deterministic
  polarity       text,                     -- success | error
  kind           text,                     -- field | template
  verified       boolean not null default false,
  payload        jsonb not null,           -- full Invariant (path/matcher/expected/template/rationale)
  proposed_at    timestamptz,
  verified_at    timestamptz
);
create index invariants_flow_idx on invariants (flow_signature);
```

### Identity (required for incremental upsert)

Invariants are array elements today with no id. Derive a deterministic one so
re-propose upserts instead of duplicating:

```
id = sha256(flow_signature | stepTitle | kind | path | matcher | expected | template)
```

### The two operations — different semantics, both non-destructive to the file

- **Propose** (`--propose`): for each flow whose `cache_key` changed, in **one
  transaction**: `DELETE FROM invariants WHERE flow_signature = $1` then insert the new
  set with `verified = false`. This is a **scoped override** — a changed input must
  discard stale proposals and their verification. Flows whose `cache_key` is unchanged
  are untouched (incremental at the flow grain, matching today's cache gate).
- **Verify** (`--verify normalized.json`): purely **incremental** —
  `UPDATE invariants SET verified = true, verified_at = now() WHERE id = ANY($held_ids)`.
  Never re-proposes, never rewrites unrelated rows.

### Read path (generation)

`loadInvariants` / `verifiedInvariantsByStep` now `SELECT … WHERE verified = true`
grouped by `flow_signature` + `step_title`, returning the same shape emit already
consumes. Generation stays deterministic and offline — it reads verified rows, makes no
LLM call.

### Files touched

- `services/script-generator/src/invariants/types.ts` — `loadInvariants` / `saveInvariants`
  become `storage`/DB-backed; add `invariantId()`.
- `services/script-generator/src/invariants/cli.ts` — propose = transactional
  delete+insert per changed flow; verify = targeted update.
- `packages/storage/migrations/` — add the `invariants` table.

## Part C — Raw-log capture via Elasticsearch (already the transport)

The cross-container log handoff is **already solved by Elasticsearch** — no MinIO
round-trip and no SUT code change needed. `log-ingestion/src/run.ts` sources raw logs by
default with `fetchFromElasticsearch(client, config.esIndex, window)` — a windowed
`_search` (`ELASTICSEARCH_URL`, default `:9200`) filtering `source: "medusa"`.
`readFromFile` / `readFromDirectory` are dev/test fallbacks only.

```
Medusa middleware → medusa-json.log (local, per-container, ephemeral)
    → log shipper (Filebeat/Logstash) → Elasticsearch → ingestion queries ES (windowed _search)
```

Because the SUT and ingestion both talk to ES over the network, they never share disk.
So:

- **`middlewares.ts` is NOT changed.** It keeps appending to its local `LOG_OUTPUT_PATH`;
  that file is just the shipper's input buffer, disposable and per-container.
- **A log shipper (Filebeat) tails `medusa-json.log` and pushes to Elasticsearch.** This
  is the only new moving part, and it is deployment config, not application code.
- **`ingest` queries ES** — nothing to hydrate for logs.

### Consequence: Elasticsearch is a third durable store

ES now holds the raw traffic capture (the pipeline's true input). Treat it as
infrastructure alongside Postgres + MinIO:

- Add `elasticsearch` + `filebeat` services to compose; wire `ELASTICSEARCH_URL` /
  `esIndex` into the `ingest` stage.
- Enable index retention (ILM) — raw logs are append-heavy; sessions/goldens derived
  from them are already persisted to MinIO, so ES retention can be short.
- Losing ES costs only the ability to re-mine from *raw* history; already-extracted
  `sessions/` and `goldens/` in MinIO survive.

### Files touched

- `docker-compose.yml` — add `elasticsearch` + `filebeat`; ship `medusa-json.log` to ES.
- `apps/platform-dashboard/server/jobs.ts` — ensure `ingest` has `ELASTICSEARCH_URL` in
  its env (no hydration).
- **No change to `apps/medusa/.../middlewares.ts`.**

## Part D — Operational hardening

1. **Runner `node_modules` (~43 MB).** Hydration pulls spec **bytes only** — not deps.
   Bake `generated-tests/node_modules` (Playwright + TS) into the runner image, or
   `npm ci` on boot. Without this every hosted test run fails at import.
2. **Bootstrap on first boot** — run Postgres migrations and create the MinIO bucket
   (idempotent) before serving.
3. **Env plumbing** — `DATABASE_URL` + MinIO creds must be in the dashboard env so
   `jobs.ts` (`spawn(..., { env: process.env })`) inherits them into every stage. Fail
   loud if absent.
4. **Multi-replica locking.** `jobs.ts` single-flight is **in-process** — with >1 replica
   two runs can collide. Move the lock to a **Postgres advisory lock**
   (`pg_advisory_lock`) keyed on the job class. (If staying single-replica, document
   the assumption instead.)
5. **Seed / decommission `data/hitl/approvals.json`.** It is git-tracked; after Plan 2
   it is stale. Keep it only as the one-shot importer's seed, then stop tracking it.
6. **Backups.** Postgres + MinIO are now the source of truth (previously "it's in git").
   Enable snapshots/retention on both. Elasticsearch holds only raw capture (derived
   `sessions/`/`goldens/` live in MinIO), so short ILM retention on ES is sufficient.
7. **Two separate databases.** Medusa (the SUT) has its **own** Postgres. The platform's
   Postgres is distinct — keep them separate services in compose so resetting one never
   touches the other.

## Steps

1. Extend the MinIO bucket layout + `jobs.ts` hydrate/persist for sessions, goldens,
   endpoint-behavior, triage (Part A).
2. Add the `invariants` table + migrate `types.ts`/`cli.ts` to incremental propose/verify
   (Part B); import existing `invariants.json` once.
3. Add `elasticsearch` + `filebeat` to compose; ship `medusa-json.log` to ES; wire
   `ELASTICSEARCH_URL` into `ingest` (Part C). No SUT code change.
4. Bake runner deps; add bootstrap (migrations + bucket); wire env; add the advisory
   lock (Part D).
5. Full hosted end-to-end on **fresh containers**: `ingest → mine → generate →
   invariants:propose → invariants:verify → test → triage → view report`, proving no
   step depends on disk surviving between jobs.

## Risks

| Risk | Mitigation |
|---|---|
| Invariants duplicate on re-propose | Deterministic `id`; upsert/delete-insert per flow in one transaction. |
| Verify runs before a report exists | `invariants:verify` hydrates `normalized.json` from MinIO and fails clearly if none — sequence it after a `test` run. |
| Ingestion starves (no raw logs) | Filebeat ships `medusa-json.log` to ES; `ingest` pings ES and fails clearly if unreachable or the windowed `_search` returns 0 docs. |
| Runner import failure | Bake deps into the runner image (Part D1) — verify a hosted `test` run imports Playwright. |
| Cross-replica double-run | Postgres advisory lock (Part D4). |

## Definition of done

- Sessions, goldens, endpoint-behavior digests, and triage persist to MinIO;
  `invariants` is a Postgres table.
- Propose is a scoped per-flow override; verify is an incremental row update; neither
  rewrites a whole artifact.
- Raw logs reach ingestion on multi-container hosting.
- A full pipeline runs on fresh containers with nothing relying on local disk surviving
  between jobs.

## Implemented

- The storage package now exposes incremental invariant operations. Local mode
  preserves the JSON seed/development artifact; remote mode uses the `invariants`
  Postgres table with transactional per-flow replacement and targeted verification.
- Dashboard jobs hydrate and persist sessions, goldens, endpoint-behavior digests,
  normalized verification input, and triage artifacts in isolated scratch workspaces.
  Missing normalized evidence fails with an operator-facing error.
- Medusa only appends structured JSON lines to `LOG_OUTPUT_PATH`. Filebeat tails the
  disposable file, Logstash indexes the events in Elasticsearch, and ingest always
  uses the windowed Elasticsearch query unless an explicit development `--file` or
  `--dir` fallback is requested.
- Elasticsearch, Logstash, and Filebeat are default Compose services. Bootstrap
  installs the flattened-field index template and a seven-day ILM deletion policy.
- Remote startup validates credentials, applies migrations, and creates the bucket.
  Runner dependencies are installed into a persistent container volume.
- A Postgres advisory lock provides cross-replica single-flight execution. Compose
  separates the SUT and platform databases, enables MinIO versioning, and includes
  opt-in retained Postgres/MinIO backup services.
