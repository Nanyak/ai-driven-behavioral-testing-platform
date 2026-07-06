# Plan 1 — Storage abstraction interface (the foundation)

**Status:** complete
**Depends on:** nothing
**Unblocks:** Plans 2 and 3

## Goal

Replace scattered `readFileSync` / `writeFileSync` calls with one pluggable `Storage`
interface. Ship it backed by the **existing filesystem** so behavior is byte-identical
and nothing breaks. This refactor is what turns Plans 2 & 3 into drop-in backend swaps
instead of invasive rewrites. It also delivers the atomic-write fix (temp + rename) for
free, closing the whole-file-rewrite corruption window in `upsertDecision` /
`deleteDecision`.

## Design

New package `packages/storage/` exposing two namespaces and a factory.

```ts
// Structured records — small, mutable, queryable
interface RecordStore {
  readJson<T>(key: string): Promise<T | null>;
  writeJson<T>(key: string, value: T): Promise<void>; // atomic in fs backend
  list(prefix: string): Promise<string[]>;
}

// Blob artifacts — spec bytes, report HTML/JSON, candidate snapshots
interface BlobStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, bytes: Buffer): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

interface Storage { records: RecordStore; blobs: BlobStore; }
```

### Keys are logical paths, not OS paths

| Logical key | fs backend maps to |
|---|---|
| `hitl/approvals` | `data/hitl/approvals.json` |
| `hitl/dismissed-relationships` | `data/hitl/dismissed-relationships.json` |
| `candidates/test-candidates-<runId>` | `services/behavior-engine/data/candidates/…json` |
| `specs/customer/happy-path/<sig>.spec.ts` | `generated-tests/customer/happy-path/…` |
| `approved-specs/customer/…` | `data/hitl/approved-specs/customer/…` |
| `reports/runs/<slug>.json` | `reports/runs/<slug>.json` |
| `manifest` | `generated-tests/.artifacts.json` |

### Factory — the backend is one env var

```ts
export const storage: Storage =
  process.env.STORAGE_BACKEND === "remote" ? makeRemoteStorage() : makeLocalStorage();
```

## Files touched

| File | Change |
|---|---|
| `packages/storage/index.ts` | **New.** Interfaces + `storage` factory. |
| `packages/storage/local.ts` | **New.** `LocalRecordStore` / `LocalBlobStore` wrapping current fs logic, byte-for-byte identical output. `writeJson` does temp-file + `renameSync` (atomic). |
| `apps/platform-dashboard/server/hitl-store.ts` | Route every read/write through `storage`. Keep `REPO_ROOT` only for the fs backend's key→path mapping. |
| `services/behavior-engine/src/selection/coverage.ts` | `fromHitlStore` reads via `storage.records.readJson("hitl/approvals")`. |
| `services/behavior-engine/src/run.ts` | Candidate write → `storage.blobs.put("candidates/…")`. |
| `services/script-generator/src/run.ts`, `src/artifacts.ts` | Spec writes, manifest write, approvals read → `storage`. |
| `services/test-runner/src/report/write.ts`, `src/run.ts` | Report writes / spec reads → `storage`. |

## Byte-identical requirement

`LocalRecordStore.writeJson` must emit exactly `JSON.stringify(value, null, 2) + "\n"`
and write to the same path the code uses today, so existing files and git diffs are
unchanged. This makes Plan 1 provably safe: output bytes do not change.

## Steps

1. Create the package; implement `LocalStorage` (records + blobs), including the atomic
   temp+rename write.
2. Migrate **`hitl-store.ts` first** (highest value, self-contained). Run
   `apps/platform-dashboard/server/hitl-store.test.ts` — must stay green.
3. Migrate the other four stages one at a time; run each stage's tests after each.
4. Add one integration assertion: a full `mine → generate → test` cycle produces an
   identical file tree whether run through the old code or the new `storage` (diff the
   trees / compare sha256 per file).

## Async ripple

The interface is `Promise`-based because Plans 2 & 3 are inherently async. Current code
is synchronous. **Recommendation: make the callers `async`** — the stage `run()`
entrypoints are already `await`-friendly. If a call site genuinely cannot go async,
expose a synchronous `localStorageSync` variant used only there; do not let it leak into
the shared interface.

## Verification

- `hitl-store.test.ts` green.
- `grep -rn "readFileSync\|writeFileSync" services/ apps/` returns only allowlisted hits
  (tests, the storage backend itself). Any other hit is a missed reader.
- End-to-end tree diff before/after is empty.

## Risks

| Risk | Mitigation |
|---|---|
| A file reader is missed | The `grep` sweep above; allowlist each remaining hit explicitly. |
| Async conversion breaks a sync assumption | Convert whole call chains at once; lean on typecheck to find sync/async mismatches. |
| Behavior drift from formatting | Assert byte-identical output in the integration test. |

## Definition of done

- All listed files go through `storage`.
- `STORAGE_BACKEND` unset (or `local`) reproduces today's behavior exactly.
- Atomic write in place for `hitl/approvals` and `hitl/dismissed-relationships`.
