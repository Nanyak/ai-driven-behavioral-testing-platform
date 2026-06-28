/**
 * The store contract here is exactly what `services/behavior-engine/src/coverage.ts`
 * parses: `{ entries: [{ flow_signature, status, ... }] }`, status in
 * {approved, discarded}, both feeding the skip gate. A missing/malformed store is
 * treated as empty here too — never fatal.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
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
  // Fallback only; downstream reads tolerate a wrong/missing root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const REPO_ROOT = findRepoRoot();

const CANDIDATES_DIR = resolve(
  REPO_ROOT,
  "services",
  "behavior-engine",
  "data",
  "candidates"
);
const GENERATED_TESTS_DIR = resolve(REPO_ROOT, "generated-tests");
const HITL_STORE = resolve(REPO_ROOT, "data", "hitl", "approvals.json");
const ARTIFACT_MANIFEST = resolve(GENERATED_TESTS_DIR, ".artifacts.json");
const REPORT_HTML = resolve(REPO_ROOT, "reports", "report.html");
const REPORT_JSON = resolve(REPO_ROOT, "reports", "report.json");
const REPORTS_RUNS_DIR = resolve(REPO_ROOT, "reports", "runs");

export function readReportHtml(): string | null {
  return existsSync(REPORT_HTML) ? readFileSync(REPORT_HTML, "utf8") : null;
}

export interface ReportRow {
  run_id: string;
  /** Filename stem, also the id used by /api/reports/view?run=<slug>. */
  slug: string;
  generated_at: string | null;
  status: "green" | "red" | "invalid";
  totals: { executed: number; passed: number; failed: number; skipped: number };
}

function parseTotals(r: {
  status?: string;
  totals?: { executed?: number; passed?: number; failed?: number; skipped?: number };
}): { status: ReportRow["status"]; totals: ReportRow["totals"] } {
  const executed = r.totals?.executed ?? 0;
  const passed = r.totals?.passed ?? 0;
  const failed = r.totals?.failed ?? 0;
  const skipped = r.totals?.skipped ?? 0;
  const status =
    r.status === "invalid" || executed === 0 || passed + failed === 0
      ? "invalid"
      : r.status === "red" || failed > 0
        ? "red"
        : "green";
  return {
    status,
    totals: { executed, passed, failed, skipped },
  };
}

export function listReports(): ReportRow[] {
  if (!existsSync(REPORTS_RUNS_DIR)) {
    return [];
  }
  const rows: ReportRow[] = [];
  for (const file of readdirSync(REPORTS_RUNS_DIR)) {
    if (!file.endsWith(".json")) continue;
    // The triage agent archives an advisory sidecar `<slug>.triage.json` next to
    // each run report; it is NOT a run (no totals/status, no matching .html), so
    // skip it here or it lists as a phantom 0/0/0 "run" with a dead view link.
    if (file.endsWith(".triage.json")) continue;
    const slug = file.slice(0, -".json".length);
    try {
      const r = JSON.parse(readFileSync(join(REPORTS_RUNS_DIR, file), "utf8")) as {
        run_id?: string;
        generated_at?: string;
        status?: string;
        totals?: { executed?: number; passed?: number; failed?: number; skipped?: number };
      };
      const { status, totals } = parseTotals(r);
      rows.push({ run_id: r.run_id ?? slug, slug, generated_at: r.generated_at ?? null, status, totals });
    } catch {
      // skip a malformed archive, never fatal
    }
  }
  rows.sort(
    (a, b) =>
      (b.generated_at ?? "").localeCompare(a.generated_at ?? "") || b.slug.localeCompare(a.slug)
  );
  return rows;
}

export function readReportHtmlById(slug: string): string | null {
  // Sanitize so a crafted slug can't escape runs/ via path traversal.
  const safe = slug.replace(/[^A-Za-z0-9._-]/g, "-");
  const path = join(REPORTS_RUNS_DIR, `${safe}.html`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function readReportSummary(): {
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  status: "green" | "red" | "invalid";
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
    const status =
      r.status === "invalid" || executed === 0 || passed + failed === 0
        ? "invalid"
        : r.status === "red" || failed > 0
          ? "red"
          : "green";
    return { executed, passed, failed, skipped, status };
  } catch {
    return null;
  }
}

// Match the full 64-hex signature stamped into each generated spec (ADR 0002).
const SIGNATURE_STAMP = /flow_signature["'\s:=]+([0-9a-f]{64})/i;

export type Decision = "approved" | "discarded";

/**
 * Where a flow sits in the review pipeline. Independent of the test file, which
 * the script-generator emits BEFORE review — approve/discard never create or delete it.
 *   - approved        : a human blessed it (kept; skipped next mine).
 *   - discarded       : a human rejected it (won't re-surface next mine).
 *   - awaiting_review : generated test exists, no decision yet ("new test scanned").
 *   - discovered      : mined candidate with no generated test yet (e.g. capped out).
 */
export type Lifecycle = "approved" | "discarded" | "awaiting_review" | "discovered";

export interface DecisionEntry {
  flow_signature: string;
  status: Decision;
  test_path?: string;
  decided_by?: string;
  decided_at?: string;
  // Enrichment so the review surface can show a prior decision and detect drift
  // even after the flow drops out of the latest candidates file. All optional —
  // older stores (and coverage.ts) ignore them; only signature+status are load-bearing.
  flow_name?: string;
  persona?: string;
  route_key?: string;
  status_signature?: string;
  step_count?: number;
  /** SHA-256 of the exact on-disk spec source approved by the operator. */
  spec_hash?: string;
  /** SHA-256 of the deterministic, redacted request-body plan shown during review. */
  body_plan_hash?: string;
  body_rule_sources?: string[];
}

export interface FlowStep {
  method: string;
  endpoint: string;
  expected_status: number;
}

/**
 * Identity of a flow's *shape* (persona + ordered method/endpoint sequence),
 * independent of expected statuses. Two flows with the same route_key but
 * different `status_signature` describe the same journey expecting different
 * outcomes — i.e. one contradicts the other (a drift/regression signal).
 */
function routeKey(persona: string, steps: FlowStep[]): string {
  return `${persona}|${steps.map((s) => `${s.method} ${s.endpoint}`).join(" > ")}`;
}

/** The ordered expected-status sequence — the "outcome" half of a flow. */
function statusSignature(steps: FlowStep[]): string {
  return steps.map((s) => s.expected_status).join(",");
}

function lifecycleOf(decision: Decision | null, hasTest: boolean): Lifecycle {
  if (decision === "approved") return "approved";
  if (decision === "discarded") return "discarded";
  return hasTest ? "awaiting_review" : "discovered";
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
  /** Persona + ordered method/endpoint sequence (outcome-independent). */
  route_key: string;
  /** Ordered expected-status sequence — the "outcome" half. */
  status_signature: string;
  /** Where this flow sits in the review pipeline (test exists ≠ decided). */
  lifecycle: Lifecycle;
  /**
   * True when an APPROVED flow exists for the same route_key (same journey) but a
   * different `status_signature` (outcome) — i.e. this newly-scanned flow runs the
   * blessed journey yet expects a different result (drift/regression).
   */
  conflicts_with_approved: boolean;
  /** Signatures of the approved baseline(s) this flow contradicts. */
  conflict_signatures: string[];
  /** The on-disk spec was repaired by the resolver-agent (carries its provenance stamp). */
  repaired_by_agent: boolean;
  /** Agent repair attempts from the last repair run (null when not repaired). */
  repair_attempts: number | null;
  /** Current artifact hashes. Approval is runnable only while both still match. */
  spec_hash: string | null;
  body_plan_hash: string | null;
  body_rule_sources: string[];
  artifact_matches_approval: boolean | null;
  /**
   * The approved baseline(s) this flow contradicts, carried INLINE (name + blessed
   * outcome). A regression shares its baseline's status-free signature, so the UI
   * cannot resolve the baseline by signature alone — it is supplied here directly.
   */
  conflict_baselines: Array<{ flow_name: string; status_signature: string }>;
}

/**
 * A decision in the store whose flow is NOT in the latest candidates file — a
 * previously approved/discarded flow that the newest mine no longer surfaced.
 * Carried so the UI can show review history and explain a conflict's other side.
 */
export interface PriorDecision {
  signature: string;
  status: Decision;
  flow_name: string;
  persona: string;
  route_key: string;
  status_signature: string;
  step_count: number;
  decided_at?: string;
}

export interface FlowsPayload {
  run_id: string | null;
  source_candidates: string | null;
  generated_at: string | null;
  flows: ReviewFlow[];
  /** Decisions not present in the latest scan (history + conflict context). */
  prior_decisions: PriorDecision[];
  counts: {
    total: number;
    approved: number;
    discarded: number;
    undecided: number;
    with_test: number;
    covered: number;
    awaiting_review: number;
    discovered: number;
    conflicts: number;
    stale_approvals: number;
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

/** The stamp the resolver-agent leaves on a spec it repaired (script-generator repair/). */
const REPAIR_PROVENANCE = "// repaired-by: resolver-agent";

interface SpecRef {
  /** repo-relative spec path. */
  path: string;
  /** True when the on-disk spec currently carries the resolver-agent stamp. */
  repairedByAgent: boolean;
  source: string;
  specHash: string;
  bodyPlanHash: string | null;
  bodyRuleSources: string[];
  bodyPlan: unknown | null;
  generatedSpecHash: string | null;
}

interface ManifestEntry {
  flow_signature: string;
  test_path: string;
  generated_spec_hash: string;
  body_plan_hash: string;
  body_rule_sources?: string[];
  body_plan?: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestBySignature(): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  if (!existsSync(ARTIFACT_MANIFEST)) return map;
  try {
    const parsed = JSON.parse(readFileSync(ARTIFACT_MANIFEST, "utf8")) as { entries?: ManifestEntry[] };
    for (const entry of parsed.entries ?? []) {
      if (typeof entry.flow_signature === "string") {
        map.set(entry.flow_signature.toLowerCase(), entry);
      }
    }
  } catch {
    // Missing/malformed review metadata never hides the generated source itself.
  }
  return map;
}

/** Map signature (lowercase 64-hex) -> its on-disk spec (path + agent-repair flag). */
function specsBySignature(): Map<string, SpecRef> {
  const map = new Map<string, SpecRef>();
  const manifests = manifestBySignature();
  for (const file of listSpecFiles(GENERATED_TESTS_DIR)) {
    const text = readFileSync(file, "utf8");
    const match = SIGNATURE_STAMP.exec(text);
    if (match) {
      const signature = match[1].toLowerCase();
      const manifest = manifests.get(signature);
      const repairedByAgent = text.includes(REPAIR_PROVENANCE);
      const specHash = sha256(text);
      const baselineBodyPlan = manifest?.body_plan ?? null;
      const effectiveBodyPlan =
        repairedByAgent && baselineBodyPlan !== null
          ? {
              baseline: baselineBodyPlan,
              agent_repair: {
                source_hash: specHash,
                authority: "Complete Playwright source is authoritative for repaired request construction.",
              },
            }
          : baselineBodyPlan;
      map.set(signature, {
        path: file.slice(REPO_ROOT.length + 1),
        repairedByAgent,
        source: text,
        specHash,
        bodyPlanHash:
          effectiveBodyPlan === null
            ? null
            : repairedByAgent
              ? sha256(JSON.stringify(effectiveBodyPlan))
              : manifest?.body_plan_hash ?? null,
        bodyRuleSources: [
          ...new Set([
            ...(manifest?.body_rule_sources ?? []),
            ...(repairedByAgent ? ["agent-repaired"] : []),
          ]),
        ],
        bodyPlan: effectiveBodyPlan,
        generatedSpecHash: manifest?.generated_spec_hash ?? null,
      });
    }
  }
  return map;
}

export interface ArtifactReview {
  signature: string;
  test_path: string;
  source: string;
  spec_hash: string;
  generated_spec_hash: string | null;
  modified_since_generation: boolean;
  body_plan_hash: string | null;
  body_rule_sources: string[];
  body_plan: unknown | null;
  approved_spec_hash: string | null;
  approved_body_plan_hash: string | null;
  matches_approval: boolean | null;
}

/** Exact executable source + redacted body plan, loaded lazily by the review panel. */
export function artifactReview(signature: string): ArtifactReview | null {
  const sig = signature.toLowerCase();
  const spec = specsBySignature().get(sig);
  if (!spec) return null;
  const decision = readDecisions().get(sig);
  const approved = decision?.status === "approved" ? decision : null;
  const matches =
    approved === null
      ? null
      : Boolean(
          approved.spec_hash &&
            approved.spec_hash === spec.specHash &&
            approved.body_plan_hash &&
            approved.body_plan_hash === spec.bodyPlanHash
        );
  return {
    signature: sig,
    test_path: spec.path,
    source: spec.source,
    spec_hash: spec.specHash,
    generated_spec_hash: spec.generatedSpecHash,
    modified_since_generation:
      spec.generatedSpecHash !== null && spec.generatedSpecHash !== spec.specHash,
    body_plan_hash: spec.bodyPlanHash,
    body_rule_sources: spec.bodyRuleSources,
    body_plan: spec.bodyPlan,
    approved_spec_hash: approved?.spec_hash ?? null,
    approved_body_plan_hash: approved?.body_plan_hash ?? null,
    matches_approval: matches,
  };
}

/* ---- Resolver-agent repair report (reports/resolver-repair.json) ---- */

const REPAIR_REPORT = resolve(REPO_ROOT, "reports", "resolver-repair.json");

interface RepairOutcomeRecord {
  signature: string;
  flowName: string;
  result: string;
  attempts: number;
  beforeSource?: string;
  afterSource?: string;
  repaired_at?: string;
}

/** Latest durable successful repair per lowercased flow signature. Empty when absent. */
function repairOutcomesBySignature(): Map<string, RepairOutcomeRecord> {
  const map = new Map<string, RepairOutcomeRecord>();
  if (!existsSync(REPAIR_REPORT)) return map;
  try {
    const doc = JSON.parse(readFileSync(REPAIR_REPORT, "utf8")) as {
      outcomes?: RepairOutcomeRecord[];
      repair_history?: RepairOutcomeRecord[];
    };
    const records = Array.isArray(doc.repair_history) ? doc.repair_history : doc.outcomes ?? [];
    for (const record of records) {
      if (
        typeof record.signature === "string" &&
        record.result === "repaired" &&
        typeof record.beforeSource === "string" &&
        typeof record.afterSource === "string"
      ) {
        // History is append-only, so a later repair for the same flow wins.
        map.set(record.signature.toLowerCase(), record);
      }
    }
  } catch {
    /* malformed report -> no repair annotations, never fatal */
  }
  return map;
}

export interface RepairDiff {
  signature: string;
  flow_name: string;
  attempts: number;
  before: string;
  after: string;
}

/** The before/after sources for a repaired flow, for the review diff. Null if none. */
export function repairDiff(signature: string): RepairDiff | null {
  const o = repairOutcomesBySignature().get(signature.toLowerCase());
  if (!o || o.result !== "repaired" || !o.beforeSource || !o.afterSource) return null;
  return {
    signature: signature.toLowerCase(),
    flow_name: o.flowName,
    attempts: o.attempts,
    before: o.beforeSource,
    after: o.afterSource,
  };
}

/**
 * Delete a generated spec by its repo-relative path (the `test_path` the UI already holds).
 * Path-scoped: the resolved target must live strictly inside `generated-tests/`, so a
 * traversal like `../../services/...` is refused rather than unlinked. This is the platform's
 * "delete this test from the browser" action — distinct from approve/discard, which never
 * touch files. Returns a tagged result; the route maps it to an HTTP status.
 */
export function deleteTestFile(
  relPath: string
): { deleted: true } | { deleted: false; reason: "invalid" | "out_of_scope" | "not_found" } {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    return { deleted: false, reason: "invalid" };
  }
  const target = resolve(REPO_ROOT, relPath);
  if (!target.startsWith(GENERATED_TESTS_DIR + sep)) {
    return { deleted: false, reason: "out_of_scope" };
  }
  if (!existsSync(target)) {
    return { deleted: false, reason: "not_found" };
  }
  unlinkSync(target);
  return { deleted: true };
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
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      map.set(sig, {
        flow_signature: sig,
        status,
        test_path: str(raw.test_path),
        decided_by: str(raw.decided_by),
        decided_at: str(raw.decided_at),
        flow_name: str(raw.flow_name),
        persona: str(raw.persona),
        route_key: str(raw.route_key),
        status_signature: str(raw.status_signature),
        step_count: typeof raw.step_count === "number" ? raw.step_count : undefined,
        spec_hash: str(raw.spec_hash),
        body_plan_hash: str(raw.body_plan_hash),
        body_rule_sources: Array.isArray(raw.body_rule_sources)
          ? raw.body_rule_sources.filter((v): v is string => typeof v === "string")
          : undefined,
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
  flow_name?: string;
  persona?: string;
  route_key?: string;
  status_signature?: string;
  step_count?: number;
  spec_hash?: string;
  body_plan_hash?: string;
  body_rule_sources?: string[];
}): DecisionEntry {
  const sig = input.flow_signature.toLowerCase();
  const decisions = readDecisions();
  const entry: DecisionEntry = {
    flow_signature: sig,
    status: input.status,
    test_path: input.test_path ?? undefined,
    decided_by: input.decided_by ?? "operator",
    decided_at: new Date().toISOString(),
    flow_name: input.flow_name,
    persona: input.persona,
    route_key: input.route_key,
    status_signature: input.status_signature,
    step_count: input.step_count,
    spec_hash: input.spec_hash,
    body_plan_hash: input.body_plan_hash,
    body_rule_sources: input.body_rule_sources,
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
  const decisions = readDecisions();
  if (!file) {
    // No latest scan, but prior decisions may still exist — surface them so the
    // history isn't lost (and the counts stay honest).
    const prior = priorDecisions(decisions, new Set());
    return {
      run_id: null,
      source_candidates: null,
      generated_at: null,
      flows: [],
      prior_decisions: prior,
      counts: {
        total: 0,
        approved: prior.filter((p) => p.status === "approved").length,
        discarded: prior.filter((p) => p.status === "discarded").length,
        undecided: 0,
        with_test: 0,
        covered: 0,
        awaiting_review: 0,
        discovered: 0,
        conflicts: 0,
        stale_approvals: 0,
      },
    };
  }

  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    run_id?: string;
    generated_at?: string;
    candidates?: RawCandidate[];
  };
  const specs = specsBySignature();
  const repairs = repairOutcomesBySignature();

  // First pass: build flows with route_key/status_signature/lifecycle.
  const flows: ReviewFlow[] = (doc.candidates ?? []).map((c) => {
    const sig = c.signature.toLowerCase();
    const specRef = specs.get(sig) ?? null;
    const testPath = specRef?.path ?? null;
    const repair = repairs.get(sig);
    const decisionEntry = decisions.get(sig);
    const decision = decisionEntry?.status ?? null;
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
      route_key: routeKey(c.persona, steps),
      status_signature: statusSignature(steps),
      lifecycle: lifecycleOf(decision, Boolean(testPath)),
      conflicts_with_approved: false,
      conflict_signatures: [],
      // Badge reflects the live spec on disk; attempts come from the last repair run.
      repaired_by_agent: specRef?.repairedByAgent ?? false,
      repair_attempts: repair?.result === "repaired" ? repair.attempts : null,
      spec_hash: specRef?.specHash ?? null,
      body_plan_hash: specRef?.bodyPlanHash ?? null,
      body_rule_sources: specRef?.bodyRuleSources ?? [],
      artifact_matches_approval:
        decision !== "approved"
          ? null
          : Boolean(
              decisionEntry?.spec_hash &&
                decisionEntry.spec_hash === specRef?.specHash &&
                decisionEntry.body_plan_hash &&
                decisionEntry.body_plan_hash === specRef?.bodyPlanHash
            ),
      conflict_baselines: [],
    };
  });

  // Second pass: map every approved route_key (journey) -> its blessed outcomes,
  // from BOTH the current scan and the prior-decision store, so a flow is flagged
  // when it runs an approved journey but expects a DIFFERENT outcome (drift). The
  // comparison is on status_signature (the outcome half), NOT signature: a
  // regression shares its baseline's status-free signature, so a signature diff
  // would never fire.
  interface Baseline {
    signature: string;
    status_signature: string;
    flow_name: string;
  }
  const approvedByRoute = new Map<string, Baseline[]>();
  const addApproved = (rk: string | undefined, base: Baseline) => {
    if (!rk || !base.status_signature) return;
    const list = approvedByRoute.get(rk) ?? [];
    if (!list.some((b) => b.status_signature === base.status_signature)) {
      list.push(base);
    }
    approvedByRoute.set(rk, list);
  };
  for (const f of flows) {
    if (f.lifecycle === "approved") {
      addApproved(f.route_key, {
        signature: f.signature,
        status_signature: f.status_signature,
        flow_name: f.flow_name,
      });
    }
  }
  for (const d of decisions.values()) {
    if (d.status === "approved") {
      addApproved(d.route_key, {
        signature: d.flow_signature,
        status_signature: d.status_signature ?? "",
        flow_name: d.flow_name ?? d.flow_signature.slice(0, 12),
      });
    }
  }

  for (const f of flows) {
    if (f.lifecycle === "approved") continue;
    const baselines = approvedByRoute.get(f.route_key);
    if (!baselines) continue;
    const differing = baselines.filter((b) => b.status_signature !== f.status_signature);
    if (differing.length > 0) {
      f.conflicts_with_approved = true;
      f.conflict_signatures = differing.map((b) => b.signature);
      f.conflict_baselines = differing.map((b) => ({
        flow_name: b.flow_name,
        status_signature: b.status_signature,
      }));
    }
  }

  const currentSigs = new Set(flows.map((f) => f.signature));
  const prior = priorDecisions(decisions, currentSigs);

  const counts = {
    total: flows.length,
    approved: flows.filter((f) => f.lifecycle === "approved").length,
    discarded: flows.filter((f) => f.lifecycle === "discarded").length,
    undecided: flows.filter((f) => f.decision === null).length,
    with_test: flows.filter((f) => f.test_path !== null).length,
    covered: flows.filter((f) => f.covered).length,
    awaiting_review: flows.filter((f) => f.lifecycle === "awaiting_review").length,
    discovered: flows.filter((f) => f.lifecycle === "discovered").length,
    conflicts: flows.filter((f) => f.conflicts_with_approved).length,
    stale_approvals: flows.filter((f) => f.artifact_matches_approval === false).length,
  };

  return {
    run_id: doc.run_id ?? null,
    source_candidates: file.slice(REPO_ROOT.length + 1),
    generated_at: doc.generated_at ?? null,
    flows,
    prior_decisions: prior,
    counts,
  };
}

/** Decisions whose flow isn't in the latest scan, with enough metadata to show. */
function priorDecisions(
  decisions: Map<string, DecisionEntry>,
  currentSigs: Set<string>
): PriorDecision[] {
  const out: PriorDecision[] = [];
  for (const d of decisions.values()) {
    if (currentSigs.has(d.flow_signature)) continue;
    // Pre-enrichment entries lack route_key/persona; they still gate the skip
    // list but can't be rendered as history, so skip them here.
    if (!d.route_key || !d.persona) continue;
    out.push({
      signature: d.flow_signature,
      status: d.status,
      flow_name: d.flow_name ?? d.flow_signature.slice(0, 12),
      persona: d.persona,
      route_key: d.route_key,
      status_signature: d.status_signature ?? "",
      step_count: d.step_count ?? 0,
      decided_at: d.decided_at,
    });
  }
  return out;
}
