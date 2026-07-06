import { makeLocalStorage } from "./local.js";
import { makeRemoteStorage } from "./remote.js";

/** Small, mutable JSON documents addressed by logical (backend-neutral) keys. */
export interface RecordStore {
  readJson<T>(key: string): Promise<T | null>;
  writeJson<T>(key: string, value: T): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Opaque artifact bytes addressed by logical (backend-neutral) keys. */
export interface BlobStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, bytes: Buffer): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface StoredInvariant {
  id: string;
  flow_signature: string;
  flow_name: string | null;
  cache_key: string | null;
  step_title: string;
  source: string;
  polarity: string | null;
  kind: string | null;
  verified: boolean;
  payload: Record<string, unknown>;
  proposed_at: string | null;
  verified_at: string | null;
}

export interface ReplaceInvariantFlow {
  flow_signature: string;
  flow_name: string;
  cache_key: string;
  proposed_at: string;
  invariants: StoredInvariant[];
}

/** Incremental invariant operations; remote implementations are transactional. */
export interface InvariantStore {
  list(options?: { verifiedOnly?: boolean }): Promise<StoredInvariant[]>;
  replaceFlow(flow: ReplaceInvariantFlow): Promise<void>;
  markVerified(ids: string[], verifiedAt?: string): Promise<number>;
}

export interface Storage {
  records: RecordStore;
  blobs: BlobStore;
  invariants: InvariantStore;
}

export { LocalBlobStore, LocalRecordStore, makeLocalStorage } from "./local.js";
export { PgRecordStore } from "./postgres.js";
export { S3BlobStore } from "./s3.js";
export { makeRemoteStorage } from "./remote.js";
export { getDir, putDir } from "./transfer.js";

function makeConfiguredStorage(): Storage {
  const backend = process.env.STORAGE_BACKEND ?? "local";
  if (backend === "local") {
    return makeLocalStorage();
  }
  if (backend === "remote") {
    return makeRemoteStorage();
  }
  throw new Error(`Unsupported STORAGE_BACKEND "${backend}". Expected "local" or "remote".`);
}

/** Process-wide storage selected solely through STORAGE_BACKEND. */
export const storage: Storage = makeConfiguredStorage();
