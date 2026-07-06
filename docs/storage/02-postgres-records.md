# Plan 2 — Postgres backend for structured records

**Status:** complete
**Depends on:** Plan 1 (`Storage` interface)

## Goal

Make the small, mutable, structured records durable and queryable in Postgres so they
survive a wiped container and scale to concurrent writers: HITL decisions,
dismissed-relationships, the run index, and the artifact manifest.

## Scope — what moves, what stays

**Moves to Postgres:** decisions, dismissed-relationships, run index, manifest —
structured, mutable, queried, needs concurrency + audit history.

**Stays a blob (Plan 3):** spec bytes, report HTML/JSON, candidate snapshots,
approved-spec snapshots.

## Schema

```sql
-- Append-only audit trail. Never hard-delete → recovers the git-history property
-- lost by leaving the filesystem. "Delete" becomes a status flip / retired_at stamp.
create table decisions (
  review_id        text primary key,
  flow_signature   text not null,
  status           text not null,          -- approved | discarded | superseded
  status_signature text,
  route_key        text,
  test_path        text,
  spec_hash        text,
  body_plan_hash   text,
  decided_by       text,
  decided_at       timestamptz not null default now(),
  superseded_by    text,
  payload          jsonb not null           -- full DecisionEntry: forward-compatible
);
create index decisions_flow_signature_idx on decisions (flow_signature);

create table dismissed_relationships (
  pair_key text primary key,
  payload  jsonb not null
);

create table run_index (
  slug         text primary key,
  generated_at timestamptz,
  status       text,                        -- green | red | invalid
  totals       jsonb
);

create table manifest (
  review_id text primary key,
  payload   jsonb not null
);
```

`payload jsonb` preserves the exact schema-tolerant shape `readDecisionHistory` already
parses, so optional fields need not each become a column — hot fields are indexed
columns, everything else rides in `payload`, and old records missing new fields still
load.

## The cross-process crux

Three processes read `approvals`: dashboard, miner (`coverage.ts`), generator
(`script-generator/src/run.ts`). All three go through `RecordStore`: the miner and
generator get a Postgres client via the same `storage` factory, and `coverage.ts`'s
`fromHitlStore` becomes a `SELECT`. Every stage needs `DATABASE_URL` in its
environment.

## Files touched

| File | Change |
|---|---|
| `packages/storage/postgres.ts` | **New.** `PgRecordStore` implementing `readJson`/`writeJson`/`list` over the tables. `writeJson("hitl/approvals", …)` upserts all decision rows in **one transaction**. |
| `apps/platform-dashboard/server/hitl-store.ts` | **No change** if Plan 1 is done right — already calls `storage.records`. |
| `services/behavior-engine/src/selection/coverage.ts` | `fromHitlStore` reads via `storage.records`. |
| `services/script-generator/src/run.ts` | Approvals read via `storage.records`. |
| `docker-compose.yml` | Add `postgres` service + named volume; wire `DATABASE_URL` into every stage. |
| `packages/storage/migrations/0001_init.sql` | **New.** Schema above. |
| `packages/storage/migrate.ts` | **New.** Apply migrations on boot. |

## Steps

1. Add Postgres to `docker-compose.yml` with a named volume; write `0001_init.sql`.
2. Implement `PgRecordStore`; unit-test it against the same contract
   `hitl-store.test.ts` exercises (swap the backend, reuse the assertions).
3. Write a **one-shot idempotent importer**: read existing
   `data/hitl/approvals.json` + `dismissed-relationships.json` → upsert rows.
4. Flip `STORAGE_BACKEND=remote`; run the dashboard; verify `loadFlows`,
   `upsertDecision`, `deleteDecision` behave identically.
5. Wire `DATABASE_URL` into the miner and generator; run a full `mine → generate` and
   confirm the skip gate still skips approved flows.

## Data migration

The importer in step 3. Keep the JSON files as a backup until Postgres is verified in
the running system. Import is upsert-on-primary-key, so re-running is safe.

## Risks

| Risk | Mitigation |
|---|---|
| Partial write corrupts the decision set | `writeJson("hitl/approvals")` upserts all rows in one transaction — the DB analog of the fs backend's temp+rename. |
| Lost git-committed audit trail | Append-only `decisions` table; `deleteDecision` flips status / stamps `retired_at` instead of hard-delete. Present as a deliberate trade. |
| Skip gate diverges across processes | Integration test: approve a flow in the dashboard, run `mine`, assert it is skipped. |
| Stage can't reach the DB | Fail loud on missing `DATABASE_URL`; document it as required env for every stage. |

## Definition of done

- Decisions / dismissed / run-index / manifest live in Postgres under
  `STORAGE_BACKEND=remote`.
- Dashboard review flow (approve / discard / delete / conflict) behaves identically to
  the filesystem backend.
- Skip gate honors Postgres approvals across the spawned miner + generator.
- One-shot importer migrates existing JSON without loss.

## Implemented

- `packages/storage/postgres.ts` provides the transactional `PgRecordStore`.
- `packages/storage/migrations/0001_init.sql` creates the record and audit tables.
- `packages/storage/migrate.ts` applies the idempotent migration.
- `packages/storage/import-local.ts` imports local records and artifacts safely on
  repeated runs.
- The generation manifest and report run index now use `RecordStore`; decisions that
  disappear from the active document receive `retired_at` and remain queryable as
  audit history.
- Real-Postgres coverage lives in `packages/storage/integration.test.ts`.
