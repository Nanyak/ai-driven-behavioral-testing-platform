import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BlobStore,
  InvariantStore,
  RecordStore,
  ReplaceInvariantFlow,
  Storage,
  StoredInvariant,
} from "./index.js";

function assertLogicalKey(key: string): string {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (
    normalized.length === 0 ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid storage key "${key}"`);
  }
  return normalized;
}

function defaultRepoRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const start of [process.cwd(), moduleDir]) {
    let dir = resolve(start);
    for (let depth = 0; depth < 10; depth += 1) {
      if (
        existsSync(resolve(dir, "services", "behavior-engine")) &&
        existsSync(resolve(dir, "apps", "platform-dashboard"))
      ) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(moduleDir, "..", "..");
}

function recordPath(repoRoot: string, key: string): string {
  const logical = assertLogicalKey(key);
  if (logical === "manifest") {
    return resolve(repoRoot, "generated-tests", ".artifacts.json");
  }
  if (logical === "run-index") {
    return resolve(repoRoot, "reports", ".run-index.json");
  }
  return resolve(repoRoot, "data", `${logical}.json`);
}

function recordKey(repoRoot: string, path: string): string {
  if (resolve(path) === resolve(repoRoot, "generated-tests", ".artifacts.json")) {
    return "manifest";
  }
  if (resolve(path) === resolve(repoRoot, "reports", ".run-index.json")) {
    return "run-index";
  }
  return relative(resolve(repoRoot, "data"), path)
    .split(sep)
    .join("/")
    .replace(/\.json$/, "");
}

function blobPath(repoRoot: string, key: string): string {
  const logical = assertLogicalKey(key);
  if (logical === "manifest") {
    return resolve(repoRoot, "generated-tests", ".artifacts.json");
  }
  const mappings: Array<[string, string, string]> = [
    ["candidates/", "services/behavior-engine/data/candidates", ".json"],
    ["validation/", "services/behavior-engine/data/validation", ".json"],
    ["sessions/", "data/sessions", ""],
    ["goldens/", "golden-responses", ""],
    ["endpoint-behavior/", "data/endpoint-behavior", ""],
    ["specs/", "generated-tests", ""],
    ["approved-specs/", "data/hitl/approved-specs", ""],
    ["reports/", "reports", ""],
  ];
  for (const [prefix, base, suffix] of mappings) {
    if (logical === prefix.slice(0, -1)) {
      return resolve(repoRoot, base);
    }
    if (logical.startsWith(prefix)) {
      return resolve(repoRoot, base, `${logical.slice(prefix.length)}${suffix}`);
    }
  }
  throw new Error(`Unknown blob storage key "${key}"`);
}

function blobKey(repoRoot: string, path: string): string {
  const normalized = resolve(path);
  const mappings: Array<[string, string, string]> = [
    ["candidates", "services/behavior-engine/data/candidates", ".json"],
    ["validation", "services/behavior-engine/data/validation", ".json"],
    ["sessions", "data/sessions", ""],
    ["goldens", "golden-responses", ""],
    ["endpoint-behavior", "data/endpoint-behavior", ""],
    ["specs", "generated-tests", ""],
    ["approved-specs", "data/hitl/approved-specs", ""],
    ["reports", "reports", ""],
  ];
  for (const [prefix, base, suffix] of mappings) {
    const root = resolve(repoRoot, base);
    if (normalized === root || normalized.startsWith(`${root}${sep}`)) {
      let rest = relative(root, normalized).split(sep).join("/");
      if (suffix && rest.endsWith(suffix)) {
        rest = rest.slice(0, -suffix.length);
      }
      if (prefix === "specs" && rest === ".artifacts.json") {
        return "manifest";
      }
      return `${prefix}/${rest}`;
    }
  }
  throw new Error(`Path "${path}" is outside the local blob store`);
}

async function filesUnder(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (info.isFile()) return [path];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await filesUnder(child)));
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
  return out;
}

export class LocalRecordStore implements RecordStore {
  constructor(private readonly repoRoot = defaultRepoRoot()) {}

  async readJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(recordPath(this.repoRoot, key), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeJson<T>(key: string, value: T): Promise<void> {
    const path = recordPath(this.repoRoot, key);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const logical = assertLogicalKey(prefix);
    if (logical === "manifest" || logical === "run-index") {
      return (await this.readJson(logical)) === null ? [] : [logical];
    }
    const exactPath = recordPath(this.repoRoot, logical);
    try {
      if ((await stat(exactPath)).isFile()) return [logical];
    } catch {
      // Fall through to treating the key as a directory prefix.
    }
    const searchRoot = resolve(this.repoRoot, "data", logical);
    return (await filesUnder(searchRoot))
      .filter((file) => file.endsWith(".json"))
      .map((file) => recordKey(this.repoRoot, file))
      .sort();
  }
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly repoRoot = defaultRepoRoot()) {}

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(blobPath(this.repoRoot, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = blobPath(this.repoRoot, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async list(prefix: string): Promise<string[]> {
    const logical = assertLogicalKey(prefix);
    if (logical === "manifest") {
      return (await this.get("manifest")) === null ? [] : ["manifest"];
    }
    const path = blobPath(this.repoRoot, logical);
    return (await filesUnder(path))
      .map((file) => blobKey(this.repoRoot, file))
      .filter(
        (key) =>
          key !== "manifest" &&
          !key.startsWith("specs/node_modules/") &&
          !key.startsWith("specs/test-results/") &&
          ![
            "specs/.DS_Store",
            "specs/.gitkeep",
            "specs/package.json",
            "specs/package-lock.json",
            "specs/tsconfig.json",
          ].includes(key)
      )
      .sort();
  }

  async delete(key: string): Promise<void> {
    await rm(blobPath(this.repoRoot, key), { force: true });
  }
}

interface LocalInvariantArtifact {
  generated_at: string;
  flows: Record<
    string,
    {
      flow_name: string;
      cache_key?: string;
      proposed_at?: string;
      invariants: Array<Record<string, unknown>>;
    }
  >;
}

function localInvariantId(flowSignature: string, payload: Record<string, unknown>): string {
  const kind = typeof payload.kind === "string" ? payload.kind : "field";
  return createHash("sha256")
    .update(
      [
        flowSignature,
        payload.stepTitle ?? "",
        kind,
        payload.path ?? "",
        kind === "field" ? payload.matcher ?? "" : "",
        kind === "field" && payload.expected !== undefined
          ? JSON.stringify(payload.expected)
          : "",
        kind === "template" ? payload.template ?? "" : "",
      ].join("|")
    )
    .digest("hex");
}

export class LocalInvariantStore implements InvariantStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly records: RecordStore) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work, work);
    this.mutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async artifact(): Promise<LocalInvariantArtifact> {
    return (
      (await this.records.readJson<LocalInvariantArtifact>("invariants/invariants")) ?? {
        generated_at: "",
        flows: {},
      }
    );
  }

  async list(options: { verifiedOnly?: boolean } = {}): Promise<StoredInvariant[]> {
    await this.mutation;
    const artifact = await this.artifact();
    const rows: StoredInvariant[] = [];
    for (const [flowSignature, flow] of Object.entries(artifact.flows)) {
      for (const payload of flow.invariants ?? []) {
        const id =
          typeof payload.id === "string"
            ? payload.id
            : localInvariantId(flowSignature, payload);
        const verified = payload.verified === true;
        if (options.verifiedOnly && !verified) continue;
        rows.push({
          id,
          flow_signature: flowSignature,
          flow_name: flow.flow_name ?? null,
          cache_key: flow.cache_key ?? null,
          step_title: typeof payload.stepTitle === "string" ? payload.stepTitle : "",
          source: typeof payload.source === "string" ? payload.source : "",
          polarity: typeof payload.polarity === "string" ? payload.polarity : null,
          kind: typeof payload.kind === "string" ? payload.kind : "field",
          verified,
          payload,
          proposed_at: flow.proposed_at ?? null,
          verified_at:
            typeof payload.verified_at === "string" ? payload.verified_at : null,
        });
      }
    }
    return rows;
  }

  async replaceFlow(flow: ReplaceInvariantFlow): Promise<void> {
    await this.serialize(async () => {
      const artifact = await this.artifact();
      artifact.generated_at = flow.proposed_at;
      artifact.flows[flow.flow_signature] = {
        flow_name: flow.flow_name,
        cache_key: flow.cache_key,
        proposed_at: flow.proposed_at,
        invariants: flow.invariants.map((row) => ({
          ...row.payload,
          id: row.id,
          verified: false,
        })),
      };
      await this.records.writeJson("invariants/invariants", artifact);
    });
  }

  async markVerified(ids: string[], verifiedAt = new Date().toISOString()): Promise<number> {
    if (ids.length === 0) return 0;
    return this.serialize(async () => {
      const held = new Set(ids);
      const artifact = await this.artifact();
      let updated = 0;
      for (const [flowSignature, flow] of Object.entries(artifact.flows)) {
        flow.invariants = flow.invariants.map((payload) => {
          const id =
            typeof payload.id === "string"
              ? payload.id
              : localInvariantId(flowSignature, payload);
          if (!held.has(id)) return payload;
          updated += 1;
          return { ...payload, id, verified: true, verified_at: verifiedAt };
        });
      }
      if (updated > 0) {
        artifact.generated_at = verifiedAt;
        await this.records.writeJson("invariants/invariants", artifact);
      }
      return updated;
    });
  }
}

export function makeLocalStorage(repoRoot = defaultRepoRoot()): Storage {
  const records = new LocalRecordStore(repoRoot);
  return {
    records,
    blobs: new LocalBlobStore(repoRoot),
    invariants: new LocalInvariantStore(records),
  };
}
