/**
 * Load candidates (plan §Implementation steps #1). Reads the newest
 * `services/behavior-engine/data/candidates/test-candidates-*.json` artifact
 * by filename timestamp.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateRequestBodyEvidence } from "../../behavior-engine/src/body-evidence.js";
import { loadSessions, type SessionFlow } from "../../behavior-engine/src/io/sessions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..");
const WORKSPACE_ROOT = process.env.STORAGE_WORKSPACE_ROOT
  ? resolvePath(process.env.STORAGE_WORKSPACE_ROOT)
  : REPO_ROOT;
const CANDIDATES_DIR = resolvePath(
  WORKSPACE_ROOT,
  "services",
  "behavior-engine",
  "data",
  "candidates"
);

export type Persona = "guest_shopper" | "registered_customer" | "admin_operator";

export interface RequestBodyEvidence {
  sample_count: number;
  body_present_count: number;
  shape_count: number;
  fields: Array<{
    path: string;
    present_count: number;
    presence_rate: number;
    masked: boolean;
    primitive_types: string[];
    safe_hints: Array<{
      type: string;
      hint: string | boolean | null;
      count: number;
    }>;
  }>;
}

export interface CandidateStep {
  method: string;
  endpoint: string;
  expected_status: number;
  /** Observed request payload, when bodies-on logging captured one (rare; ADR 0001). */
  request_payload?: unknown;
  /** Aggregated privacy-safe request shape evidence from supporting sessions. */
  request_body_evidence?: RequestBodyEvidence;
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
  const candidateFile = JSON.parse(readFileSync(file, "utf8")) as CandidateFile;
  if (
    candidateFile.candidates.every((candidate) =>
      candidate.steps.every((step) => step.request_body_evidence !== undefined)
    )
  ) {
    return candidateFile;
  }

  // Backward-compatible enrichment for candidate artifacts created before body
  // evidence became part of the mining contract. This reads only privacy-safe
  // request_body_features from the candidate's own source sessions; it never
  // copies request_payload values and does not rewrite the candidate file.
  try {
    const sessions = loadSessions().sessions;
    const byId = new Map(sessions.map((session) => [session.session_id, session]));
    for (const candidate of candidateFile.candidates) {
      const supporting = candidate.source_sessions
        .map((id) => byId.get(id))
        .filter((session): session is SessionFlow => session !== undefined);
      for (const step of candidate.steps) {
        step.request_body_evidence ??= aggregateRequestBodyEvidence(
          supporting,
          step.method,
          step.endpoint,
          step.expected_status
        );
      }
    }
  } catch {
    // Missing/malformed session artifacts keep legacy behavior: OAS-required
    // fields only. Generation remains available and deterministic.
  }
  return candidateFile;
}
