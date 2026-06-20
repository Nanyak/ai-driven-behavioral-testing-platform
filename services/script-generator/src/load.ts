/**
 * Load candidates (plan §Implementation steps #1). Reads the newest
 * `services/behavior-engine/data/candidates/test-candidates-*.json` artifact
 * by filename timestamp.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANDIDATES_DIR = resolvePath(__dirname, "..", "..", "behavior-engine", "data", "candidates");

export type Persona = "guest_shopper" | "registered_customer" | "admin_operator";

export interface CandidateStep {
  method: string;
  endpoint: string;
  expected_status: number;
  /** Observed request payload, when bodies-on logging captured one (rare; ADR 0001). */
  request_payload?: unknown;
}

export interface CandidateAttributes {
  requires_auth: boolean;
  is_admin: boolean;
  has_errors: boolean;
}

export interface Candidate {
  flow_name: string;
  persona: Persona;
  persona_source: string;
  attributes: CandidateAttributes;
  priority: string;
  support: number;
  score: number;
  signature: string;
  assertion_hints: { fields: string[]; source: string };
  anomaly_note: string | null;
  source_sessions: string[];
  steps: CandidateStep[];
}

export interface CandidateFile {
  run_id: string;
  candidate_count: number;
  per_persona_counts: Record<string, number>;
  candidates: Candidate[];
}

/** Extract the sortable timestamp embedded in `test-candidates-<ts>.json`. */
function timestampOf(filename: string): string {
  const match = /^test-candidates-(.+)\.json$/.exec(filename);
  return match ? match[1] : "";
}

/** Find the newest candidates file in `dir` by embedded filename timestamp. */
export function newestCandidatesFile(dir: string = CANDIDATES_DIR): string {
  const files = readdirSync(dir).filter((f) => /^test-candidates-.+\.json$/.test(f));
  if (files.length === 0) {
    throw new Error(`No test-candidates-*.json files found in ${dir}`);
  }
  files.sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
  return resolvePath(dir, files[files.length - 1]);
}

/** Load and parse the newest (or explicitly given) candidates file. */
export function loadCandidates(path?: string): CandidateFile {
  const file = path ?? newestCandidatesFile();
  return JSON.parse(readFileSync(file, "utf8")) as CandidateFile;
}
