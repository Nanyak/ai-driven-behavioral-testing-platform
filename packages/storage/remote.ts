import type { Storage } from "./index.js";
import { PgInvariantStore, PgRecordStore, applyMigrations, makePgPool } from "./postgres.js";
import { makeS3BlobStore } from "./s3.js";

export function makeRemoteStorage(): Storage {
  const pool = makePgPool();
  // Apply migrations ONCE and hand both PG-backed stores the same ready promise,
  // rather than letting each constructor kick off its own concurrent pass.
  const ready = applyMigrations(pool);
  return {
    records: new PgRecordStore(pool, ready),
    blobs: makeS3BlobStore(),
    invariants: new PgInvariantStore(pool, ready),
  };
}
