# Plan 3 — MinIO / S3 backend for spec & report artifacts

**Status:** complete
**Depends on:** Plan 1 (`Storage` interface); pairs well with Plan 2

## Goal

Store generated specs, approved-spec snapshots, reports, and candidate snapshots as
durable objects in MinIO/S3, hydrated to a scratch workspace for the Playwright runner
and persisted back on completion. This is the standard "build artifacts in object
storage" pattern — a legitimately good design for a distributed test pipeline, not
decoration.

## The core constraint

**Playwright must execute specs from a real filesystem.** So the object store is the
source of truth and the container's disk is a per-run scratch cache. The design is a
hydrate / execute / persist loop, orchestrated by `jobs.ts`.

```
[generate] stage writes specs to scratch  →  jobs.ts: putDir("specs/", scratch/generated-tests)
[test]     jobs.ts: getDir("specs/" → scratch/generated-tests)  →  spawn runner
                     stage writes reports to scratch  →  jobs.ts: putDir("reports/", scratch/reports)
[dashboard] serves a report by streaming blobs.get("reports/runs/<slug>.html")
```

## Bucket layout

One bucket (e.g. `platwright`):

```
specs/{guest,customer,admin}/<subpath>/<sig>.spec.ts   # current generated specs
approved-specs/<same subpath>                           # blessed byte snapshots
candidates/test-candidates-<runId>.json
reports/report.{html,json}
reports/runs/<slug>.{html,json}
reports/resolver-repair.json
```

> The artifact manifest (`.artifacts.json`) and run index are structured metadata you
> query — prefer keeping them in Postgres (Plan 2), not the bucket, so the dashboard
> lists runs without a bucket scan.

## Files touched

| File | Change |
|---|---|
| `packages/storage/s3.ts` | **New.** `S3BlobStore` on AWS SDK v3 (`@aws-sdk/client-s3`), `endpoint` + `forcePathStyle: true` for MinIO. |
| `apps/platform-dashboard/server/jobs.ts` | **Main new logic.** `hydrate(job)` / `persist(job)` around `spawn`: which prefixes to pull before and push after, per job id. |
| `apps/platform-dashboard/server/hitl-store.ts` | Report/spec-serving routes stream from `blobs.get`; `snapshotApprovedSpec` / `specsByReview` / `deleteTestFile` already go through `storage.blobs` after Plan 1. |
| `services/*/…` path roots | In the remote backend, `GENERATED_TESTS_DIR` and report paths point at the **per-run scratch root** (an env var), not `REPO_ROOT`. |
| `docker-compose.yml` | Add `minio` service + volume; `MINIO_ENDPOINT`, keys, bucket bootstrap. |

## Steps

1. Add MinIO to `docker-compose.yml`; create the bucket on boot (init container or a
   startup existence check).
2. Implement `S3BlobStore`; unit-test against a MinIO test container.
3. Add `hydrate` / `persist` helpers: `getDir(prefix → scratchDir)` and
   `putDir(scratchDir → prefix)` = list prefix + stream each object to/from a scratch
   dir under the OS temp dir.
4. Wire per-job hydrate/persist in `jobs.ts`:
   - `generate` → persist `specs/`, `approved-specs/`, `candidates/`
   - `test:*` → hydrate `specs/`, then persist `reports/`
   - `repair` → hydrate `specs/`, persist `specs/` + `reports/resolver-repair.json`
5. Point the dashboard's report/spec-serving routes at `blobs.get`.
6. End-to-end in the remote backend: `mine → generate → test → view report`. Confirm
   specs execute and the report renders in the browser.

## Data migration

One-shot `putDir` of the current `generated-tests/`, `data/hitl/approved-specs/`,
`reports/`, and `services/behavior-engine/data/candidates/` into MinIO.

## Risks

| Risk | Mitigation |
|---|---|
| Runner still needs a filesystem | Embrace it — the scratch dir is expected. Ensure `GENERATED_TESTS_DIR` / report roots resolve to the per-run scratch root via env, not `REPO_ROOT`. |
| Approval byte-exactness breaks | The HITL trust model is hash-exact specs. Assert sha256 round-trips through `putDir`/`getDir`, or approvals silently go stale. |
| Report links 404 after redeploy | Serve reports by streaming `blobs.get`, never by a local path that no longer exists. |
| Scratch dir collisions across concurrent jobs | Single-flight (`jobs.ts`) already serializes; still namespace the scratch root per run id. |

## Definition of done

- Specs, approved-specs, reports, candidates persist to MinIO under
  `STORAGE_BACKEND=remote`.
- `generate` → `test` works with a **fresh** container each step (nothing relies on
  disk surviving between jobs) — proving statelessness.
- Reports render in the dashboard streamed from object storage.
- Approved specs round-trip byte-identically (hash-verified).

## Implemented

- `packages/storage/s3.ts` provides the AWS SDK v3 S3/MinIO backend, bucket
  bootstrap, paginated listing, and binary-safe reads/writes.
- `packages/storage/transfer.ts` provides traversal-safe `getDir` / `putDir`
  hydration helpers.
- `apps/platform-dashboard/server/jobs.ts` creates a unique OS-temp workspace,
  hydrates job inputs, points stages at it with `STORAGE_WORKSPACE_ROOT`, persists
  outputs, and removes the workspace.
- The generator, repair CLI, and runner resolve generated specs/reports from that
  workspace while source code and static inputs continue to resolve from the repo.
- Docker Compose includes durable MinIO storage and an idempotent bucket-init job.
- Unit and real-MinIO integration checks verify SHA-256-identical byte round trips.
