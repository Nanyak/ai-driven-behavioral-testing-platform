import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResult } from "pg";
import type { RecordStore } from "./index.js";
import type {
  InvariantStore,
  ReplaceInvariantFlow,
  StoredInvariant,
} from "./index.js";

type JsonObject = Record<string, unknown>;

export interface Queryable {
  query<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClient>;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function entries(value: unknown, property = "entries"): JsonObject[] {
  const document = object(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(document[property])
      ? document[property]
      : [];
  return list.filter(
    (entry): entry is JsonObject =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
  );
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required when STORAGE_BACKEND=remote");
  }
  return url;
}

export function makePgPool(): Pool {
  return new Pool({
    connectionString: databaseUrl(),
    allowExitOnIdle: true,
    max: Number(process.env.STORAGE_PG_POOL_SIZE ?? 10),
  });
}

export async function applyMigrations(pool: Queryable): Promise<void> {
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
  for (const name of ["0001_init.sql", "0002_invariants.sql"]) {
    const sql = await readFile(resolve(migrationsDir, name), "utf8");
    // Migrations are idempotent so a pristine database can apply the marker table
    // and every schema object in one bootstrap pass.
    await pool.query(sql);
    await pool.query(
      "insert into storage_migrations(name) values ($1) on conflict (name) do nothing",
      [name]
    );
  }
}

/**
 * Resolve a store's `ready` gate. `true` runs migrations, `false` skips them, and
 * a supplied promise lets sibling stores SHARE one migration pass — so building a
 * remote `Storage` (record + invariant store on the same pool) applies the schema
 * once instead of two concurrent `create table if not exists` sessions that can
 * race on Postgres catalog tables.
 */
function resolveReady(pool: Queryable, migrate: boolean | Promise<void>): Promise<void> {
  if (typeof migrate === "boolean") {
    return migrate ? applyMigrations(pool) : Promise.resolve();
  }
  return migrate;
}

export class PgInvariantStore implements InvariantStore {
  private readonly ready: Promise<void>;

  constructor(
    private readonly pool: PoolLike = makePgPool(),
    migrate: boolean | Promise<void> = true
  ) {
    this.ready = resolveReady(pool, migrate);
  }

  async list(options: { verifiedOnly?: boolean } = {}): Promise<StoredInvariant[]> {
    await this.ready;
    const result = await this.pool.query<{
      id: string;
      flow_signature: string;
      flow_name: string | null;
      cache_key: string | null;
      step_title: string;
      source: string;
      polarity: string | null;
      kind: string | null;
      verified: boolean;
      payload: JsonObject;
      proposed_at: Date | string | null;
      verified_at: Date | string | null;
    }>(
      `select id, flow_signature, flow_name, cache_key, step_title, source,
              polarity, kind, verified, payload, proposed_at, verified_at
         from invariants
        ${options.verifiedOnly ? "where verified = true" : ""}
        order by flow_signature, step_title, id`
    );
    const iso = (value: Date | string | null): string | null =>
      value instanceof Date ? value.toISOString() : value;
    return result.rows.map((row) => ({
      ...row,
      payload: row.payload,
      proposed_at: iso(row.proposed_at),
      verified_at: iso(row.verified_at),
    }));
  }

  async replaceFlow(flow: ReplaceInvariantFlow): Promise<void> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from invariants where flow_signature = $1", [
        flow.flow_signature,
      ]);
      for (const row of flow.invariants) {
        await client.query(
          `insert into invariants (
             id, flow_signature, flow_name, cache_key, step_title, source,
             polarity, kind, verified, payload, proposed_at, verified_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,false,$9::jsonb,$10::timestamptz,null)`,
          [
            row.id,
            flow.flow_signature,
            flow.flow_name,
            flow.cache_key,
            row.step_title,
            row.source,
            row.polarity,
            row.kind,
            JSON.stringify({ ...row.payload, id: row.id, verified: false }),
            flow.proposed_at,
          ]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markVerified(ids: string[], verifiedAt = new Date().toISOString()): Promise<number> {
    await this.ready;
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `update invariants
          set verified = true,
              verified_at = $2::timestamptz,
              payload = jsonb_set(payload, '{verified}', 'true'::jsonb, true)
        where id = any($1::text[])`,
      [ids, verifiedAt]
    );
    return result.rowCount ?? 0;
  }
}

export class PgRecordStore implements RecordStore {
  private readonly ready: Promise<void>;

  constructor(
    private readonly pool: PoolLike = makePgPool(),
    migrate: boolean | Promise<void> = true
  ) {
    this.ready = resolveReady(pool, migrate);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async readJson<T>(key: string): Promise<T | null> {
    await this.ready;
    if (key === "hitl/approvals") {
      const result = await this.pool.query<{ payload: JsonObject }>(
        "select payload from decisions where retired_at is null order by decided_at, review_id"
      );
      return (result.rows.length === 0 ? null : { entries: result.rows.map((row) => row.payload) }) as T | null;
    }
    if (key === "hitl/dismissed-relationships") {
      const result = await this.pool.query<{ payload: JsonObject }>(
        "select payload from dismissed_relationships order by pair_key"
      );
      return (result.rows.length === 0
        ? null
        : { dismissed: result.rows.map((row) => row.payload) }) as T | null;
    }
    if (key === "manifest") {
      const [rows, metadata] = await Promise.all([
        this.pool.query<{ payload: JsonObject }>("select payload from manifest order by review_id"),
        this.pool.query<{ payload: JsonObject }>(
          "select payload from storage_metadata where key = 'manifest'"
        ),
      ]);
      if (rows.rows.length === 0 && metadata.rows.length === 0) return null;
      return {
        ...metadata.rows[0]?.payload,
        entries: rows.rows.map((row) => row.payload),
      } as T;
    }
    if (key === "run-index") {
      const result = await this.pool.query<{ payload: JsonObject }>(
        "select payload from run_index order by generated_at desc nulls last, slug desc"
      );
      return (result.rows.length === 0 ? null : { entries: result.rows.map((row) => row.payload) }) as T | null;
    }
    throw new Error(`Unsupported PostgreSQL record key "${key}"`);
  }

  async writeJson<T>(key: string, value: T): Promise<void> {
    if (key === "hitl/approvals") {
      const rows = entries(value);
      await this.transaction(async (client) => {
        const activeIds: string[] = [];
        for (const payload of rows) {
          const flowSignature = string(payload.flow_signature) ?? string(payload.signature);
          if (!flowSignature) throw new Error("Decision is missing flow_signature");
          const statusSignature = string(payload.status_signature) ?? "";
          const reviewId =
            string(payload.review_id) ?? `${flowSignature.toLowerCase()}:${statusSignature || "unknown"}`;
          const status = string(payload.status);
          if (!status || !["approved", "discarded", "superseded"].includes(status)) {
            throw new Error(`Decision "${reviewId}" has an invalid status`);
          }
          activeIds.push(reviewId);
          await client.query(
            `insert into decisions (
               review_id, flow_signature, status, status_signature, route_key, test_path,
               spec_hash, body_plan_hash, decided_by, decided_at, superseded_by, retired_at, payload
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11,null,$12::jsonb)
             on conflict (review_id) do update set
               flow_signature=excluded.flow_signature, status=excluded.status,
               status_signature=excluded.status_signature, route_key=excluded.route_key,
               test_path=excluded.test_path, spec_hash=excluded.spec_hash,
               body_plan_hash=excluded.body_plan_hash, decided_by=excluded.decided_by,
               decided_at=excluded.decided_at, superseded_by=excluded.superseded_by,
               retired_at=null, payload=excluded.payload`,
            [
              reviewId,
              flowSignature.toLowerCase(),
              status,
              statusSignature || null,
              string(payload.route_key),
              string(payload.test_path),
              string(payload.spec_hash),
              string(payload.body_plan_hash),
              string(payload.decided_by),
              string(payload.decided_at),
              string(payload.superseded_by),
              JSON.stringify({ ...payload, review_id: reviewId, flow_signature: flowSignature.toLowerCase() }),
            ]
          );
        }
        await client.query(
          activeIds.length === 0
            ? "update decisions set retired_at=coalesce(retired_at, now()) where retired_at is null"
            : "update decisions set retired_at=coalesce(retired_at, now()) where retired_at is null and not (review_id = any($1::text[]))",
          activeIds.length === 0 ? [] : [activeIds]
        );
      });
      return;
    }

    if (key === "hitl/dismissed-relationships") {
      const rows = entries(value, "dismissed");
      await this.transaction(async (client) => {
        const keys: string[] = [];
        for (const payload of rows) {
          const ids = Array.isArray(payload.review_ids)
            ? payload.review_ids.filter((id): id is string => typeof id === "string")
            : [];
          if (ids.length !== 2) throw new Error("Dismissed relationship must contain two review_ids");
          const pairKey = ids.map((id) => id.toLowerCase()).sort().join("||");
          keys.push(pairKey);
          await client.query(
            `insert into dismissed_relationships(pair_key, payload) values ($1,$2::jsonb)
             on conflict (pair_key) do update set payload=excluded.payload`,
            [pairKey, JSON.stringify(payload)]
          );
        }
        await client.query(
          keys.length === 0
            ? "delete from dismissed_relationships"
            : "delete from dismissed_relationships where not (pair_key = any($1::text[]))",
          keys.length === 0 ? [] : [keys]
        );
      });
      return;
    }

    if (key === "manifest") {
      const rows = entries(value);
      const document = object(value);
      const metadata = { ...document };
      delete metadata.entries;
      await this.transaction(async (client) => {
        const ids: string[] = [];
        for (const payload of rows) {
          const reviewId =
            string(payload.review_id) ??
            `${string(payload.flow_signature) ?? "unknown"}:${string(payload.status_signature) ?? "unknown"}`;
          ids.push(reviewId);
          await client.query(
            `insert into manifest(review_id, payload) values ($1,$2::jsonb)
             on conflict (review_id) do update set payload=excluded.payload`,
            [reviewId, JSON.stringify(payload)]
          );
        }
        await client.query(
          ids.length === 0
            ? "delete from manifest"
            : "delete from manifest where not (review_id = any($1::text[]))",
          ids.length === 0 ? [] : [ids]
        );
        await client.query(
          `insert into storage_metadata(key, payload) values ('manifest',$1::jsonb)
           on conflict (key) do update set payload=excluded.payload`,
          [JSON.stringify(metadata)]
        );
      });
      return;
    }

    if (key === "run-index") {
      const rows = entries(value);
      await this.transaction(async (client) => {
        for (const payload of rows) {
          const slug = string(payload.slug);
          if (!slug) throw new Error("Run-index entry is missing slug");
          await client.query(
            `insert into run_index(slug, generated_at, status, totals, payload)
             values ($1,$2::timestamptz,$3,$4::jsonb,$5::jsonb)
             on conflict (slug) do update set generated_at=excluded.generated_at,
               status=excluded.status, totals=excluded.totals, payload=excluded.payload`,
            [
              slug,
              string(payload.generated_at),
              string(payload.status),
              JSON.stringify(payload.totals ?? null),
              JSON.stringify(payload),
            ]
          );
        }
      });
      return;
    }

    throw new Error(`Unsupported PostgreSQL record key "${key}"`);
  }

  async list(prefix: string): Promise<string[]> {
    const keys = ["hitl/approvals", "hitl/dismissed-relationships", "manifest", "run-index"];
    const matched: string[] = [];
    for (const key of keys) {
      if ((key === prefix || key.startsWith(`${prefix}/`)) && (await this.readJson(key)) !== null) {
        matched.push(key);
      }
    }
    return matched;
  }
}
