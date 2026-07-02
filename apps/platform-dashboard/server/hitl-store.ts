/**
 * The store contract here is exactly what `services/behavior-engine/src/coverage.ts`
 * parses: `{ entries: [{ flow_signature, status, ... }] }`, status in
 * Active decisions are {approved, discarded}; superseded approvals remain as
 * audit history. All terminal versions feed the outcome-aware skip gate.
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
import { selectBusinessScenarios } from "../../../services/behavior-engine/src/selection/scenarios.js";

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
export type StoredDecision = Decision | "superseded";

export function reviewId(flowSignature: string, statusSignature: string): string {
  return `${flowSignature.toLowerCase()}:${statusSignature || "unknown"}`;
}

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
  review_id?: string;
  flow_signature: string;
  status: StoredDecision;
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
  superseded_at?: string;
  superseded_by?: string;
  /** Stable business-scenario family selected by the current mine. */
  scenario_key?: string;
}

type JourneyIdentity = {
  flow_signature: string;
  route_key?: string;
};

/**
 * Conflict and supersession identity is deliberately narrow: the same canonical
 * flow signature, or an exactly equal persisted route key. Scenario families are
 * presentation groupings and must never make related routes contradict or retire
 * one another.
 */
export function matchesExactJourney(
  left: JourneyIdentity,
  right: JourneyIdentity
): boolean {
  if (left.flow_signature.toLowerCase() === right.flow_signature.toLowerCase()) {
    return true;
  }
  const leftRoute = left.route_key?.trim();
  const rightRoute = right.route_key?.trim();
  return Boolean(leftRoute && rightRoute && leftRoute === rightRoute);
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

function inferDecisionScenarioKey(input: {
  flow_signature: string;
  flow_name?: string;
  persona?: string;
  route_key?: string;
  status_signature?: string;
}): string | undefined {
  if (!input.persona || !input.route_key) return undefined;
  const route = input.route_key.includes("|")
    ? input.route_key.slice(input.route_key.indexOf("|") + 1)
    : input.route_key;
  const statuses = (input.status_signature ?? "")
    .split(",")
    .map((value) => Number(value));
  const steps = route
    .split(" > ")
    .map((token, index) => {
      const space = token.indexOf(" ");
      if (space <= 0) return null;
      return {
        method: token.slice(0, space),
        endpoint: token.slice(space + 1),
        expected_status: Number.isFinite(statuses[index]) ? statuses[index] : 0,
      };
    })
    .filter((step): step is FlowStep => step !== null);
  if (steps.length === 0) return undefined;
  return selectBusinessScenarios([
    {
      signature: input.flow_signature,
      flow_name: input.flow_name ?? "Resolved flow",
      persona: input.persona,
      steps,
    },
  ]).representatives[0]?.family_key;
}

function lifecycleOf(decision: Decision | null, hasTest: boolean): Lifecycle {
  if (decision === "approved") return "approved";
  if (decision === "discarded") return "discarded";
  return hasTest ? "awaiting_review" : "discovered";
}

export interface ReviewFlow {
  review_id: string;
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
  /** The currently runnable baseline for this journey, when it differs from this version. */
  active_baseline: {
    review_id: string;
    flow_name: string;
    status_signature: string;
    test_path: string | null;
    decided_at?: string;
  } | null;
  first_seen_run: string | null;
  last_seen_run: string | null;
  seen_in_latest_run: boolean;
  version_count: number;
  versions: Array<{
    review_id: string;
    status_signature: string;
    lifecycle: Lifecycle | "superseded";
    test_path: string | null;
    first_seen_run: string | null;
    last_seen_run: string | null;
    decided_at?: string;
  }>;
  /** Stable persona + business intent + material outcome grouping key. */
  family_key: string;
  /** All current route observations represented by this one review row. */
  variant_count: number;
  variants: Array<{
    review_id: string;
    signature: string;
    flow_name: string;
    support: number;
    score: number;
    step_count: number;
    status_signature: string;
    is_representative: boolean;
  }>;
  /** Why a current representative lacks a draft. Null once generation succeeds. */
  not_generated_reason: "generation_pending" | null;
}

/**
 * A decision in the store whose flow is NOT in the latest candidates file — a
 * previously approved/discarded flow that the newest mine no longer surfaced.
 * Carried so the UI can show review history and explain a conflict's other side.
 */
export interface PriorDecision {
  review_id: string;
  signature: string;
  status: StoredDecision;
  flow_name: string;
  persona: string;
  route_key: string;
  status_signature: string;
  step_count: number;
  decided_at?: string;
  test_path: string | null;
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

/** Candidate snapshots in chronological order (timestamped, lexicographically sortable). */
function candidateFiles(): string[] {
  if (!existsSync(CANDIDATES_DIR)) {
    return [];
  }
  return readdirSync(CANDIDATES_DIR)
    .filter((f) => f.startsWith("test-candidates-") && f.endsWith(".json"))
    .sort()
    .map((file) => join(CANDIDATES_DIR, file));
}

/** Newest `test-candidates-*.json` by filename. */
function newestCandidatesFile(): string | null {
  return candidateFiles().at(-1) ?? null;
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
  review_id?: string;
  flow_signature: string;
  status_signature?: string;
  test_path: string;
  generated_spec_hash: string;
  body_plan_hash: string;
  body_rule_sources?: string[];
  body_plan?: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestByReview(): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  if (!existsSync(ARTIFACT_MANIFEST)) return map;
  try {
    const parsed = JSON.parse(readFileSync(ARTIFACT_MANIFEST, "utf8")) as { entries?: ManifestEntry[] };
    for (const entry of parsed.entries ?? []) {
      if (typeof entry.flow_signature === "string") {
        const id =
          entry.review_id?.trim() ||
          reviewId(entry.flow_signature, entry.status_signature ?? "");
        map.set(id, entry);
        if (!entry.review_id && !entry.status_signature) {
          map.set(entry.flow_signature.toLowerCase(), entry);
        }
      }
    }
  } catch {
    // Missing/malformed review metadata never hides the generated source itself.
  }
  return map;
}

/** Map outcome-aware review id -> its on-disk spec (path + agent-repair flag). */
function specsByReview(): Map<string, SpecRef> {
  const map = new Map<string, SpecRef>();
  const manifests = manifestByReview();
  for (const file of listSpecFiles(GENERATED_TESTS_DIR)) {
    const text = readFileSync(file, "utf8");
    const match = SIGNATURE_STAMP.exec(text);
    if (match) {
      const signature = match[1].toLowerCase();
      const statusSignature = /status_signature["'\s:=]+([\d,]+)/i.exec(text)?.[1] ?? "";
      const id = reviewId(signature, statusSignature);
      const manifest = manifests.get(id) ?? manifests.get(signature);
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
      map.set(id, {
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
  review_id: string;
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

/** Exact executable source + redacted body plan, loaded lazily by review version. */
export function artifactReview(signature: string, statusSignature = ""): ArtifactReview | null {
  const sig = signature.toLowerCase();
  const id = reviewId(sig, statusSignature);
  const specs = specsByReview();
  const spec =
    specs.get(id) ??
    (statusSignature === ""
      ? [...specs.entries()].find(([key]) => key.startsWith(`${sig}:`))?.[1]
      : undefined);
  if (!spec) return null;
  const decision = readDecisionHistory().get(id);
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
    review_id: id,
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

/** Read the complete outcome-versioned decision history. */
export function readDecisionHistory(): Map<string, DecisionEntry> {
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
      (status === "approved" || status === "discarded" || status === "superseded")
    ) {
      const sig = signature.toLowerCase();
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const outcome = str(raw.status_signature) ?? "";
      const id = str(raw.review_id) ?? reviewId(sig, outcome);
      const decision: DecisionEntry = {
        review_id: id,
        flow_signature: sig,
        status,
        test_path: str(raw.test_path),
        decided_by: str(raw.decided_by),
        decided_at: str(raw.decided_at),
        flow_name: str(raw.flow_name),
        persona: str(raw.persona),
        route_key: str(raw.route_key),
        status_signature: outcome,
        step_count: typeof raw.step_count === "number" ? raw.step_count : undefined,
        spec_hash: str(raw.spec_hash),
        body_plan_hash: str(raw.body_plan_hash),
        body_rule_sources: Array.isArray(raw.body_rule_sources)
          ? raw.body_rule_sources.filter((v): v is string => typeof v === "string")
          : undefined,
        superseded_at: str(raw.superseded_at),
        superseded_by: str(raw.superseded_by),
        scenario_key: str(raw.scenario_key),
      };
      decision.scenario_key ??= inferDecisionScenarioKey(decision);
      map.set(id, decision);
    }
  }
  return map;
}

/**
 * Compatibility projection used by existing callers: one active decision per
 * journey. An active approval wins; otherwise the latest discard is returned.
 */
export function readDecisions(): Map<string, DecisionEntry> {
  const projected = new Map<string, DecisionEntry>();
  const entries = [...readDecisionHistory().values()]
    .filter((entry) => entry.status !== "superseded")
    .sort((a, b) => (a.decided_at ?? "").localeCompare(b.decided_at ?? ""));
  for (const entry of entries) {
    const prior = projected.get(entry.flow_signature);
    if (!prior || entry.status === "approved" || prior.status !== "approved") {
      projected.set(entry.flow_signature, entry);
    }
  }
  return projected;
}

/**
 * Upsert one decision keyed by outcome-aware review id. Approving a new outcome
 * supersedes the previous active baseline without deleting its audit record.
 * Writes the store in the `{ entries: [...] }` shape coverage.ts parses, creating
 * `data/hitl/` if needed.
 */
export function upsertDecision(input: {
  review_id?: string;
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
  scenario_key?: string;
}): DecisionEntry {
  const sig = input.flow_signature.toLowerCase();
  const outcome = input.status_signature ?? "";
  const id = input.review_id ?? reviewId(sig, outcome);
  const scenarioKey =
    input.scenario_key ??
    inferDecisionScenarioKey({
      flow_signature: sig,
      flow_name: input.flow_name,
      persona: input.persona,
      route_key: input.route_key,
      status_signature: outcome,
    });
  const decisions = readDecisionHistory();
  const now = new Date().toISOString();
  if (input.status === "approved") {
    for (const [priorId, prior] of decisions) {
      if (
        priorId !== id &&
        matchesExactJourney(prior, {
          flow_signature: sig,
          route_key: input.route_key,
        }) &&
        prior.status === "approved"
      ) {
        decisions.set(priorId, {
          ...prior,
          status: "superseded",
          superseded_at: now,
          superseded_by: id,
        });
      }
    }
  }
  const entry: DecisionEntry = {
    review_id: id,
    flow_signature: sig,
    status: input.status,
    test_path: input.test_path ?? undefined,
    decided_by: input.decided_by ?? "operator",
    decided_at: now,
    flow_name: input.flow_name,
    persona: input.persona,
    route_key: input.route_key,
    status_signature: outcome,
    step_count: input.step_count,
    spec_hash: input.spec_hash,
    body_plan_hash: input.body_plan_hash,
    body_rule_sources: input.body_rule_sources,
    scenario_key: scenarioKey,
  };
  decisions.set(id, entry);

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
  anomaly_note?: string | null;
}

interface CandidateObservation {
  candidate: RawCandidate;
  firstSeenRun: string | null;
  lastSeenRun: string | null;
  order: number;
  seenInLatest: boolean;
}

/**
 * Load the active review queue. The newest mine is authoritative for undecided
 * work; older candidate files provide first-seen metadata only. Terminal
 * decisions remain separately available as resolved history.
 */
export function loadFlows(): FlowsPayload {
  const files = candidateFiles();
  const latestFile = files.at(-1) ?? null;
  const observations = new Map<string, CandidateObservation>();
  let latestRunId: string | null = null;
  let latestGeneratedAt: string | null = null;
  let latestCandidates: RawCandidate[] = [];
  let order = 0;

  for (const file of files) {
    let doc: { run_id?: string; generated_at?: string; candidates?: RawCandidate[] };
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as typeof doc;
    } catch {
      continue;
    }
    const isLatest = file === latestFile;
    if (isLatest) {
      latestRunId = doc.run_id ?? null;
      latestGeneratedAt = doc.generated_at ?? null;
      latestCandidates = doc.candidates ?? [];
    }
    for (const candidate of doc.candidates ?? []) {
      const sig = candidate.signature.toLowerCase();
      const id = reviewId(sig, statusSignature(candidate.steps ?? []));
      const prior = observations.get(id);
      observations.set(id, {
        candidate,
        firstSeenRun: prior?.firstSeenRun ?? doc.run_id ?? null,
        lastSeenRun: doc.run_id ?? null,
        order: order++,
        seenInLatest: isLatest,
      });
    }
  }

  const decisions = readDecisionHistory();
  const approvedSignatures = new Set(
    [...decisions.values()]
      .filter((entry) => entry.status === "approved")
      .map((entry) => entry.flow_signature)
  );
  const selected = selectBusinessScenarios(
    latestCandidates.map((candidate) => ({ ...candidate, steps: candidate.steps ?? [] })),
    approvedSignatures
  );
  const specs = specsByReview();
  const repairs = repairOutcomesBySignature();
  const activeReviewIds = new Set<string>();
  const flows: ReviewFlow[] = [];

  for (const family of selected.representatives) {
    const c = family.candidate;
    const sig = c.signature.toLowerCase();
    const steps = c.steps ?? [];
    const outcome = statusSignature(steps);
    const id = reviewId(sig, outcome);
    activeReviewIds.add(id);
    const observed = observations.get(id);
    const exactDecision = decisions.get(id);
    const publicDecision =
      exactDecision?.status === "approved" || exactDecision?.status === "discarded"
        ? exactDecision.status
        : null;
    const specRef = specs.get(id) ?? null;
    const repair = repairs.get(sig);
    const currentRouteKey = routeKey(c.persona, steps);
    const baseline = [...decisions.values()]
      .filter(
        (entry) =>
          entry.status === "approved" &&
          matchesExactJourney(entry, {
            flow_signature: sig,
            route_key: currentRouteKey,
          })
      )
      .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))[0];
    const baselineId = baseline
      ? baseline.review_id ?? reviewId(sig, baseline.status_signature ?? "")
      : null;
    const baselineSpec = baselineId ? specs.get(baselineId) ?? null : null;
    const conflicts = Boolean(
      baseline && baseline.status_signature !== outcome && publicDecision === null
    );

    const versionIds = new Set<string>([id]);
    for (const [versionId, decision] of decisions) {
      if (decision.flow_signature === sig) versionIds.add(versionId);
    }
    const versions = [...versionIds].map((versionId) => {
      const decision = decisions.get(versionId);
      const versionSpec = specs.get(versionId);
      const versionObservation = observations.get(versionId);
      const lifecycle: Lifecycle | "superseded" =
        decision?.status === "superseded"
          ? "superseded"
          : lifecycleOf(
              decision?.status === "approved" || decision?.status === "discarded"
                ? decision.status
                : null,
              Boolean(versionSpec)
            );
      return {
        review_id: versionId,
        status_signature:
          statusSignature(versionObservation?.candidate.steps ?? []) ||
          decision?.status_signature ||
          "",
        lifecycle,
        test_path: versionSpec?.path ?? null,
        first_seen_run: versionObservation?.firstSeenRun ?? null,
        last_seen_run: versionObservation?.lastSeenRun ?? null,
        decided_at: decision?.decided_at,
      };
    });

    flows.push({
      review_id: id,
      signature: sig,
      flow_name: family.scenario_name,
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
      test_path: specRef?.path ?? null,
      decision: publicDecision,
      covered: Boolean(specRef) || publicDecision !== null,
      route_key: currentRouteKey,
      status_signature: outcome,
      lifecycle: lifecycleOf(publicDecision, Boolean(specRef)),
      conflicts_with_approved: conflicts,
      conflict_signatures: conflicts && baseline ? [baseline.flow_signature] : [],
      repaired_by_agent: specRef?.repairedByAgent ?? false,
      repair_attempts: repair?.result === "repaired" ? repair.attempts : null,
      spec_hash: specRef?.specHash ?? null,
      body_plan_hash: specRef?.bodyPlanHash ?? null,
      body_rule_sources: specRef?.bodyRuleSources ?? [],
      artifact_matches_approval:
        publicDecision !== "approved"
          ? null
          : Boolean(
              exactDecision?.spec_hash &&
                exactDecision.spec_hash === specRef?.specHash &&
                exactDecision.body_plan_hash &&
                exactDecision.body_plan_hash === specRef?.bodyPlanHash
            ),
      conflict_baselines:
        conflicts && baseline
          ? [{
              flow_name: baseline.flow_name ?? family.scenario_name,
              status_signature: baseline.status_signature ?? "",
            }]
          : [],
      active_baseline:
        baseline && baselineId && baselineId !== id
          ? {
              review_id: baselineId,
              flow_name: baseline.flow_name ?? family.scenario_name,
              status_signature: baseline.status_signature ?? "",
              test_path: baselineSpec?.path ?? null,
              decided_at: baseline.decided_at,
            }
          : null,
      first_seen_run: observed?.firstSeenRun ?? latestRunId,
      last_seen_run: latestRunId,
      seen_in_latest_run: true,
      version_count: versions.length,
      versions,
      family_key: family.family_key,
      variant_count: family.variants.length,
      variants: family.variants.map((variant) => {
        const variantOutcome = statusSignature(variant.steps ?? []);
        return {
          review_id: reviewId(variant.signature, variantOutcome),
          signature: variant.signature.toLowerCase(),
          flow_name: variant.flow_name,
          support: variant.support ?? 0,
          score: variant.score ?? 0,
          step_count: variant.steps.length,
          status_signature: variantOutcome,
          is_representative: variant.signature.toLowerCase() === sig && variantOutcome === outcome,
        };
      }),
      not_generated_reason: specRef ? null : "generation_pending",
    });
  }

  const priorDecisions: PriorDecision[] = [...decisions.entries()]
    .filter(([id]) => !activeReviewIds.has(id))
    .map(([id, decision]) => ({
      review_id: id,
      signature: decision.flow_signature,
      status: decision.status,
      flow_name: decision.flow_name ?? "Resolved flow",
      persona: decision.persona ?? "unknown",
      route_key: decision.route_key ?? "",
      status_signature: decision.status_signature ?? "",
      step_count: decision.step_count ?? 0,
      decided_at: decision.decided_at,
      test_path: specs.get(id)?.path ?? decision.test_path ?? null,
    }))
    .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""));

  const counts = {
    total: flows.length,
    approved: flows.filter(
      (flow) => flow.lifecycle === "approved" || flow.active_baseline !== null
    ).length,
    discarded: flows.filter((flow) => flow.lifecycle === "discarded").length,
    undecided: flows.filter((flow) => flow.decision === null).length,
    with_test: flows.filter((flow) => flow.test_path !== null).length,
    covered: flows.filter((flow) => flow.covered).length,
    awaiting_review: flows.filter((flow) => flow.lifecycle === "awaiting_review").length,
    discovered: flows.filter((flow) => flow.lifecycle === "discovered").length,
    conflicts: flows.filter((flow) => flow.conflicts_with_approved).length,
    stale_approvals: flows.filter((flow) => flow.artifact_matches_approval === false).length,
  };

  return {
    run_id: latestRunId,
    source_candidates: latestFile ? latestFile.slice(REPO_ROOT.length + 1) : null,
    generated_at: latestGeneratedAt,
    flows,
    prior_decisions: priorDecisions,
    counts,
  };
}
