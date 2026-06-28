/**
 * Input stage: read session-flow records from repo-root `data/sessions/`.
 *
 * This mirrors the ingestion service's path resolution exactly (it WRITES to
 * repo-root `data/sessions/`, log-ingestion/config.ts) — the behavior engine is
 * NOT a service-local sessions dir. By default we pick the newest
 * `session-flows-*.json`, matching the ingestion run-id naming so "latest run"
 * is unambiguous.
 *
 * GUARDRAIL: this module loads records verbatim. It does NOT read or strip
 * `role_observed` / `session_id` source tags — those travel through to the
 * validation stage as ground truth only. Mining/classification modules simply
 * never look at them (attributes.ts reads endpoint + status only).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVICE_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(SERVICE_ROOT, "..", "..");

/** Repo-root `data/sessions/` — the ingestion output dir (shared, read-only here). */
export const SESSIONS_DIR = resolve(REPO_ROOT, "data", "sessions");

export interface RequestBodyFeatures {
  present: boolean;
  kind: string;
  field_paths: string[];
  masked_field_paths: string[];
  primitive_type_paths: Array<{ path: string; type: string }>;
  array_lengths: Array<{ path: string; length: number; bucket: string }>;
  safe_scalar_hints: Array<{
    path: string;
    type: string;
    hint: string | boolean | null;
  }>;
  shape_hash: string | null;
  truncated: boolean;
}

/** One step of a session-flow record (log-ingestion data contract). */
export interface FlowStep {
  method: string;
  endpoint: string;
  event: string | null;
  status: number;
  trace_id: string | null;
  timestamp: string;
  request_payload: unknown;
  request_body_features?: RequestBodyFeatures;
  has_error: boolean;
}

/**
 * A session-flow record. `role_observed` and `session_id` are present but are
 * VALIDATION-ONLY — see the guardrail above.
 */
export interface SessionFlow {
  session_id: string;
  started_at: string;
  ended_at: string;
  role_observed: Array<"guest" | "customer" | "admin">;
  steps: FlowStep[];
}

/** Newest `session-flows-*.json` in the sessions dir, or null if none exist. */
export function latestSessionsFile(dir: string = SESSIONS_DIR): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const files = entries
    .filter((f) => f.startsWith("session-flows-") && f.endsWith(".json"))
    .sort();
  return files.length > 0 ? resolve(dir, files[files.length - 1]) : null;
}

export interface LoadResult {
  file: string;
  sessions: SessionFlow[];
}

/**
 * Load session flows. With no `file`, resolves the newest artifact in
 * repo-root `data/sessions/`. Throws at this boundary if nothing is found or the
 * file is not a JSON array (a real operator-facing error, not an impossible case).
 */
export function loadSessions(file?: string): LoadResult {
  const path = file ?? latestSessionsFile();
  if (!path) {
    throw new Error(
      `No session-flows-*.json found in ${SESSIONS_DIR}. Run ingestion first ` +
        `(npm run ingest:run -- --file logs/medusa-json.log --from <iso>).`
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array of session flows in ${path}.`);
  }
  return { file: path, sessions: parsed as SessionFlow[] };
}
