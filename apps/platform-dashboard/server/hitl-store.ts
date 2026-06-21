/**
 * HITL review data layer (Phase 15).
 *
 * Pure, framework-free read/merge/write over three artifacts produced by earlier
 * phases:
 *   - discovered flows + ranking ........ services/behavior-engine/data/candidates/test-candidates-*.json (Phase 7)
 *   - generated tests (signature stamp).. generated-tests/ ** /*.spec.ts (Phase 9, ADR 0002)
 *   - the approval/discard store ........ data/hitl/approvals.json (this phase; read by behavior-engine/coverage.ts)
 *
 * The store contract is exactly what `services/behavior-engine/src/coverage.ts`
 * parses: `{ entries: [{ flow_signature, status, ... }] }`, status in
 * {approved, discarded}, both feeding the skip gate. A missing/malformed store is
 * treated as empty here too — never fatal (PO-6 / BA-F8).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the repo root by walking up until we find the monorepo markers. This is
 * robust whether the module runs under tsx (its own path) or under Vite (which
 * bundles vite.config + plugins into a temp file, so `import.meta.url` is not the
 * source location). Walk from cwd first, then from the module path as a fallback.
 */
function findRepoRoot(): string {
  const isRoot = (dir: string) =>
    existsSync(join(dir, "services", "behavior-engine")) &&
    existsSync(join(dir, "apps", "platform-dashboard"));
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let dir = start;
    for (let i = 0; i < 8; i += 1) {
      if (isRoot(dir)) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  // Last-resort default (clean-checkout safe: downstream reads tolerate absence).
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const REPO_ROOT = findRepoRoot();

const CANDIDATES_DIR = resolve(
  REPO_ROOT,
  "services",
  "behavior-engine",
  "data",
  "candidates"
);
const GENERATED_TESTS_DIR = resolve(REPO_ROOT, "generated-tests");
const HITL_STORE = resolve(REPO_ROOT, "data", "hitl", "approvals.json");
const REPORT_HTML = resolve(REPO_ROOT, "reports", "report.html");
const REPORT_JSON = resolve(REPO_ROOT, "reports", "report.json");

/** The self-contained Phase 11 report HTML, or null if no run has produced one. */
export function readReportHtml(): string | null {
  return existsSync(REPORT_HTML) ? readFileSync(REPORT_HTML, "utf8") : null;
}

/** Headline totals from the Phase 11 report, or null if absent/malformed. */
export function readReportSummary(): {
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  status: "green" | "red";
} | null {
  if (!existsSync(REPORT_JSON)) {
    return null;
  }
  try {
    const r = JSON.parse(readFileSync(REPORT_JSON, "utf8")) as {
      status?: string;
      totals?: { executed?: number; passed?: number; failed?: number; skipped?: number };
    };
    const executed = r.totals?.executed ?? 0;
    const passed = r.totals?.passed ?? 0;
    const failed = r.totals?.failed ?? 0;
    const skipped = r.totals?.skipped ?? 0;
    return { executed, passed, failed, skipped, status: r.status === "red" || failed > 0 ? "red" : "green" };
  } catch {
    return null;
  }
}

// Match the full 64-hex signature stamped into each generated spec (ADR 0002).
const SIGNATURE_STAMP = /flow_signature["'\s:=]+([0-9a-f]{64})/i;

export type Decision = "approved" | "discarded";

export interface DecisionEntry {
  flow_signature: string;
  status: Decision;
  test_path?: string;
  decided_by?: string;
  decided_at?: string;
}

export interface FlowStep {
  method: string;
  endpoint: string;
  expected_status: number;
}

export interface ReviewFlow {
  signature: string;
  flow_name: string;
  persona: string;
  attributes: { requires_auth: boolean; is_admin: boolean; has_errors: boolean };
  priority: string;
  support: number;
  score: number;
  step_count: number;
  steps: FlowStep[];
  assertion_fields: string[];
  source_sessions: string[];
  test_path: string | null;
  decision: Decision | null;
  /** Already covered by the skip gate (has a generated test and/or a decision). */
  covered: boolean;
}

export interface FlowsPayload {
  run_id: string | null;
  source_candidates: string | null;
  generated_at: string | null;
  flows: ReviewFlow[];
  counts: {
    total: number;
    approved: number;
    discarded: number;
    undecided: number;
    with_test: number;
    covered: number;
  };
}

/** Newest `test-candidates-*.json` by filename (timestamped, lexicographically sortable). */
function newestCandidatesFile(): string | null {
  if (!existsSync(CANDIDATES_DIR)) {
    return null;
  }
  const files = readdirSync(CANDIDATES_DIR)
    .filter((f) => f.startsWith("test-candidates-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  return join(CANDIDATES_DIR, files[files.length - 1]);
}

/** Recursively list `*.spec.ts` files under a dir; [] if absent. */
function listSpecFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSpecFiles(full));
    } else if (entry.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Map signature (lowercase 64-hex) -> repo-relative spec path. */
function specsBySignature(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of listSpecFiles(GENERATED_TESTS_DIR)) {
    const match = SIGNATURE_STAMP.exec(readFileSync(file, "utf8"));
    if (match) {
      map.set(match[1].toLowerCase(), file.slice(REPO_ROOT.length + 1));
    }
  }
  return map;
}

/** Read the approval store as a signature->entry map. Empty if missing/malformed. */
export function readDecisions(): Map<string, DecisionEntry> {
  const map = new Map<string, DecisionEntry>();
  if (!existsSync(HITL_STORE)) {
    return map;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(HITL_STORE, "utf8"));
  } catch {
    return map; // malformed store -> treated as empty, never fatal.
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: DecisionEntry[] }).entries
      : [];
  for (const raw of entries as Array<Record<string, unknown>>) {
    const signature = raw.flow_signature ?? raw.signature;
    const status = raw.status;
    if (
      typeof signature === "string" &&
      (status === "approved" || status === "discarded")
    ) {
      const sig = signature.toLowerCase();
      map.set(sig, {
        flow_signature: sig,
        status,
        test_path: typeof raw.test_path === "string" ? raw.test_path : undefined,
        decided_by: typeof raw.decided_by === "string" ? raw.decided_by : undefined,
        decided_at: typeof raw.decided_at === "string" ? raw.decided_at : undefined,
      });
    }
  }
  return map;
}

/**
 * Upsert one decision keyed by flow signature — never appends a duplicate.
 * Writes the store in the `{ entries: [...] }` shape coverage.ts parses, creating
 * `data/hitl/` if needed.
 */
export function upsertDecision(input: {
  flow_signature: string;
  status: Decision;
  test_path?: string | null;
  decided_by?: string;
}): DecisionEntry {
  const sig = input.flow_signature.toLowerCase();
  const decisions = readDecisions();
  const entry: DecisionEntry = {
    flow_signature: sig,
    status: input.status,
    test_path: input.test_path ?? undefined,
    decided_by: input.decided_by ?? "operator",
    decided_at: new Date().toISOString(),
  };
  decisions.set(sig, entry);

  mkdirSync(dirname(HITL_STORE), { recursive: true });
  const entries = [...decisions.values()];
  writeFileSync(HITL_STORE, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  return entry;
}

interface RawCandidate {
  flow_name: string;
  persona: string;
  attributes?: { requires_auth?: boolean; is_admin?: boolean; has_errors?: boolean };
  priority?: string;
  support?: number;
  score?: number;
  signature: string;
  assertion_hints?: { fields?: string[] };
  source_sessions?: string[];
  steps?: FlowStep[];
}

/** Load discovered flows, joined with their generated test and current decision. */
export function loadFlows(): FlowsPayload {
  const file = newestCandidatesFile();
  if (!file) {
    return {
      run_id: null,
      source_candidates: null,
      generated_at: null,
      flows: [],
      counts: { total: 0, approved: 0, discarded: 0, undecided: 0, with_test: 0, covered: 0 },
    };
  }

  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    run_id?: string;
    generated_at?: string;
    candidates?: RawCandidate[];
  };
  const specs = specsBySignature();
  const decisions = readDecisions();

  const flows: ReviewFlow[] = (doc.candidates ?? []).map((c) => {
    const sig = c.signature.toLowerCase();
    const testPath = specs.get(sig) ?? null;
    const decision = decisions.get(sig)?.status ?? null;
    const steps = c.steps ?? [];
    return {
      signature: sig,
      flow_name: c.flow_name,
      persona: c.persona,
      attributes: {
        requires_auth: Boolean(c.attributes?.requires_auth),
        is_admin: Boolean(c.attributes?.is_admin),
        has_errors: Boolean(c.attributes?.has_errors),
      },
      priority: c.priority ?? "medium",
      support: c.support ?? 0,
      score: c.score ?? 0,
      step_count: steps.length,
      steps,
      assertion_fields: c.assertion_hints?.fields ?? [],
      source_sessions: c.source_sessions ?? [],
      test_path: testPath,
      decision,
      covered: Boolean(testPath) || decision !== null,
    };
  });

  const counts = {
    total: flows.length,
    approved: flows.filter((f) => f.decision === "approved").length,
    discarded: flows.filter((f) => f.decision === "discarded").length,
    undecided: flows.filter((f) => f.decision === null).length,
    with_test: flows.filter((f) => f.test_path !== null).length,
    covered: flows.filter((f) => f.covered).length,
  };

  return {
    run_id: doc.run_id ?? null,
    source_candidates: file.slice(REPO_ROOT.length + 1),
    generated_at: doc.generated_at ?? null,
    flows,
    counts,
  };
}
