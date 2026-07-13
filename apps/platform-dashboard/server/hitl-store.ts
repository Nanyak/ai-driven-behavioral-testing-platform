/**
 * The store contract here is exactly what `services/behavior-engine/src/coverage.ts`
 * parses: `{ entries: [{ flow_signature, status, ... }] }`, status in
 * Active decisions are {approved, discarded}; superseded approvals remain as
 * audit history. All terminal versions feed the outcome-aware skip gate.
 */

import {
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectBusinessScenarios } from "../../../services/behavior-engine/src/selection/scenarios.js";
import { storage } from "../../../packages/storage/index.js";

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

// Tracked snapshot of every approved spec's exact bytes. generated-tests/ is
// gitignored (ephemeral) AND approved flows are skip-gated out of candidates, so
// generate never re-emits them — it only PRESERVES the on-disk file. If that file
// is lost (a cleaned tree, a checkout), the approval would dangle. Snapshotting the
// approved bytes here lets generate restore it verbatim (hash-exact, approval stays
// valid). Mirrors the spec's generated-tests sub-path so restore is a plain copy.
/** Copy an approved flow's current on-disk spec into the tracked snapshot store. */
async function snapshotApprovedSpec(testPath: string): Promise<void> {
  const relative = testPath.replace(/^generated-tests[/\\]/, "");
  const source = await storage.blobs.get(`specs/${relative}`);
  if (source !== null) await storage.blobs.put(`approved-specs/${relative}`, source);
}

/** Drop an approved flow's snapshot (on delete), so a retired flow can't be
 * silently restored by a later generate. */
async function removeApprovedSnapshot(testPath: string): Promise<void> {
  const relative = testPath.replace(/^generated-tests[/\\]/, "");
  await storage.blobs.delete(`approved-specs/${relative}`);
}
// Advisory "these two versions are distinct scenarios, not an override" records.
// Deliberately its OWN file — coverage.ts parses approvals.json and must not see
// these presentation-only records (see readDismissedRelationships below).
export async function readReportHtml(): Promise<string | null> {
  return (await storage.blobs.get("reports/report.html"))?.toString("utf8") ?? null;
}

/** Mutation-evaluation metrics HTML, published by `npm run eval:mutate`. Null
 * until a run exists. Served verbatim by /api/eval/view. */
export async function readEvalMetricsHtml(): Promise<string | null> {
  return (await storage.blobs.get("reports/eval/mutation-metrics.html"))?.toString("utf8") ?? null;
}

export interface EvalMetricsSummary {
  generated_at: string | null;
  target: string | null;
  mutation_score: number;
  total_mutants: number;
  caught: number;
  survived: number;
  inconclusive: number;
  executability_rate: number | null;
  baseline_clean: boolean | null;
  survivors: Array<{ endpoint: string; status: number; operator: string; path: string | null; id: string }>;
}

/** Compact KPI projection of the eval metrics for the Overview strip. Null when
 * no run has been published yet. */
export async function readEvalMetricsSummary(): Promise<EvalMetricsSummary | null> {
  try {
    const bytes = await storage.blobs.get("reports/eval/mutation-metrics.json");
    if (bytes === null) return null;
    const m = JSON.parse(bytes.toString("utf8")) as {
      generated_at?: string;
      target?: string;
      mutation_score?: number;
      total_mutants?: number;
      killed?: number;
      survived?: number;
      inconclusive?: number;
      executability_rate?: number;
      baseline_clean?: boolean;
      survivors?: Array<{ endpoint: string; status: number; operator: string; path: string | null; id: string }>;
    };
    return {
      generated_at: m.generated_at ?? null,
      target: m.target ?? null,
      mutation_score: m.mutation_score ?? 0,
      total_mutants: m.total_mutants ?? 0,
      caught: m.killed ?? 0,
      survived: m.survived ?? 0,
      inconclusive: m.inconclusive ?? 0,
      executability_rate: m.executability_rate ?? null,
      baseline_clean: m.baseline_clean ?? null,
      survivors: m.survivors ?? [],
    };
  } catch {
    return null;
  }
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

export async function listReports(): Promise<ReportRow[]> {
  try {
    const index = await storage.records.readJson<{ entries?: ReportRow[] }>(
      "run-index"
    );
    if (index?.entries) {
      return [...index.entries].sort(
        (a, b) =>
          (b.generated_at ?? "").localeCompare(a.generated_at ?? "") ||
          b.slug.localeCompare(a.slug)
      );
    }
  } catch {
    // Existing local deployments may not have an index yet; scan report blobs.
  }
  const rows: ReportRow[] = [];
  for (const key of await storage.blobs.list("reports/runs")) {
    if (!key.endsWith(".json")) continue;
    // The triage agent archives an advisory sidecar `<slug>.triage.json` next to
    // each run report; it is NOT a run (no totals/status, no matching .html), so
    // skip it here or it lists as a phantom 0/0/0 "run" with a dead view link.
    if (key.endsWith(".triage.json")) continue;
    const slug = key.slice("reports/runs/".length, -".json".length);
    try {
      const bytes = await storage.blobs.get(key);
      if (bytes === null) continue;
      const r = JSON.parse(bytes.toString("utf8")) as {
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

export async function readReportHtmlById(slug: string): Promise<string | null> {
  // Sanitize so a crafted slug can't escape runs/ via path traversal.
  const safe = slug.replace(/[^A-Za-z0-9._-]/g, "-");
  return (await storage.blobs.get(`reports/runs/${safe}.html`))?.toString("utf8") ?? null;
}

export async function readReportSummary(): Promise<{
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  status: "green" | "red" | "invalid";
} | null> {
  try {
    const bytes = await storage.blobs.get("reports/report.json");
    if (bytes === null) return null;
    const r = JSON.parse(bytes.toString("utf8")) as {
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

/**
 * Reconstruct the ordered `FlowStep[]` from a persisted `route_key` (persona +
 * "METHOD endpoint > …") and its parallel `status_signature` ("200,401,…"). Used
 * to show steps for a decision whose flow has left the latest candidate set, and
 * to feed scenario-key inference. Returns [] when the route is empty/malformed.
 */
export function stepsFromRoute(routeKey?: string, statusSignature?: string): FlowStep[] {
  if (!routeKey) return [];
  const route = routeKey.includes("|")
    ? routeKey.slice(routeKey.indexOf("|") + 1)
    : routeKey;
  const statuses = (statusSignature ?? "").split(",").map((value) => Number(value));
  return route
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
}

function inferDecisionScenarioKey(input: {
  flow_signature: string;
  flow_name?: string;
  persona?: string;
  route_key?: string;
  status_signature?: string;
}): string | undefined {
  if (!input.persona || !input.route_key) return undefined;
  const steps = stepsFromRoute(input.route_key, input.status_signature);
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
    /** The baseline's flow signature, so the UI can load its artifact for the request diff. */
    signature: string;
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
  /** Ordered steps reconstructed from route_key + status_signature, so the detail
   * panel can show the journey even after the flow leaves the latest mine. */
  steps: FlowStep[];
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
async function candidateFiles(): Promise<string[]> {
  return (await storage.blobs.list("candidates"))
    .filter((key) => key.startsWith("candidates/test-candidates-"))
    .sort();
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

async function manifestByReview(): Promise<Map<string, ManifestEntry>> {
  const map = new Map<string, ManifestEntry>();
  try {
    const parsed = await storage.records.readJson<{ entries?: ManifestEntry[] }>(
      "manifest"
    );
    if (parsed === null) return map;
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
async function specsByReview(): Promise<Map<string, SpecRef>> {
  const map = new Map<string, SpecRef>();
  const manifests = await manifestByReview();
  const keys = (
    await Promise.all(
      ["guest", "customer", "admin"].map((persona) =>
        storage.blobs.list(`specs/${persona}`)
      )
    )
  ).flat();
  for (const key of keys) {
    if (!key.endsWith(".spec.ts")) continue;
    const bytes = await storage.blobs.get(key);
    if (bytes === null) continue;
    const text = bytes.toString("utf8");
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
        path: `generated-tests/${key.slice("specs/".length)}`,
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
export async function artifactReview(
  signature: string,
  statusSignature = ""
): Promise<ArtifactReview | null> {
  const sig = signature.toLowerCase();
  const id = reviewId(sig, statusSignature);
  const specs = await specsByReview();
  const spec =
    specs.get(id) ??
    (statusSignature === ""
      ? [...specs.entries()].find(([key]) => key.startsWith(`${sig}:`))?.[1]
      : undefined);
  if (!spec) return null;
  const decision = (await readDecisionHistory()).get(id);
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
async function repairOutcomesBySignature(): Promise<Map<string, RepairOutcomeRecord>> {
  const map = new Map<string, RepairOutcomeRecord>();
  try {
    const bytes = await storage.blobs.get("reports/resolver-repair.json");
    if (bytes === null) return map;
    const doc = JSON.parse(bytes.toString("utf8")) as {
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
export async function repairDiff(signature: string): Promise<RepairDiff | null> {
  const o = (await repairOutcomesBySignature()).get(signature.toLowerCase());
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
export async function deleteTestFile(
  relPath: string
): Promise<
  { deleted: true } | { deleted: false; reason: "invalid" | "out_of_scope" | "not_found" }
> {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    return { deleted: false, reason: "invalid" };
  }
  const normalized = relPath.replace(/\\/g, "/");
  if (
    !normalized.startsWith("generated-tests/") ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    return { deleted: false, reason: "out_of_scope" };
  }
  const key = `specs/${normalized.slice("generated-tests/".length)}`;
  if ((await storage.blobs.get(key)) === null) {
    return { deleted: false, reason: "not_found" };
  }
  await storage.blobs.delete(key);
  return { deleted: true };
}

/** Read the complete outcome-versioned decision history. */
export async function readDecisionHistory(): Promise<Map<string, DecisionEntry>> {
  const map = new Map<string, DecisionEntry>();
  try {
    const parsed = await storage.records.readJson<unknown>("hitl/approvals");
    if (parsed === null) return map;
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
  } catch {
    return map; // malformed store -> treated as empty, never fatal.
  }
  return map;
}

/**
 * Compatibility projection used by existing callers: one active decision per
 * journey. An active approval wins; otherwise the latest discard is returned.
 */
export async function readDecisions(): Promise<Map<string, DecisionEntry>> {
  const projected = new Map<string, DecisionEntry>();
  const entries = [...(await readDecisionHistory()).values()]
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
 * Upsert one decision keyed by outcome-aware review id. Approval is NON-destructive
 * and additive by default: it NEVER auto-supersedes a related approved baseline,
 * because "same journey, different outcome" is ambiguous (genuine drift vs. two
 * legitimately-distinct scenarios) and taking the irreversible path on an inference
 * is wrong for a HITL tool. Supersession happens ONLY when the caller explicitly
 * names baselines in `supersede_review_ids` (the opt-in "Replace <baseline>" action).
 * Writes the store in the `{ entries: [...] }` shape coverage.ts parses, creating
 * `data/hitl/` if needed.
 */
export async function upsertDecision(input: {
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
  /** Opt-in "Replace": approved baseline review id(s) to mark superseded in this write. */
  supersede_review_ids?: string[];
}): Promise<DecisionEntry> {
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
  const decisions = await readDecisionHistory();
  const now = new Date().toISOString();
  // Explicit, opt-in supersession ONLY. A plain Approve coexists with any related
  // baseline; the operator must choose "Replace <baseline>", which names the exact
  // review id(s) to retire here. We still keep the superseded record as audit history.
  if (input.status === "approved" && input.supersede_review_ids?.length) {
    for (const supersedeId of input.supersede_review_ids) {
      const prior = decisions.get(supersedeId);
      if (prior && supersedeId !== id && prior.status === "approved") {
        decisions.set(supersedeId, {
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

  const entries = [...decisions.values()];
  await storage.records.writeJson("hitl/approvals", { entries });

  // Snapshot the exact approved bytes so generate can restore the spec if the
  // gitignored generated-tests/ tree is ever cleaned (see APPROVED_SPECS_DIR).
  if (entry.status === "approved" && entry.test_path) {
    await snapshotApprovedSpec(entry.test_path);
  }
  return entry;
}

/**
 * Delete a decision (typically an approval) by its outcome-aware review id. Removes
 * the record from the store AND unlinks its generated spec so the flow is fully
 * retired — the "delete the approved flow" action. Path-scoped spec removal reuses
 * deleteTestFile. Returns a tagged result the route maps to an HTTP status.
 */
export async function deleteDecision(
  reviewId: string
): Promise<
  | { deleted: true; spec_deleted: boolean; test_path: string | null }
  | { deleted: false; reason: "invalid" | "not_found" }
> {
  if (typeof reviewId !== "string" || reviewId.trim().length === 0) {
    return { deleted: false, reason: "invalid" };
  }
  const decisions = await readDecisionHistory();
  const entry = decisions.get(reviewId);
  if (!entry) {
    return { deleted: false, reason: "not_found" };
  }
  decisions.delete(reviewId);
  await storage.records.writeJson("hitl/approvals", {
    entries: [...decisions.values()],
  });
  // Prefer the spec actually on disk for this review; fall back to the recorded path.
  const testPath = (await specsByReview()).get(reviewId)?.path ?? entry.test_path ?? null;
  let specDeleted = false;
  if (testPath) {
    specDeleted = (await deleteTestFile(testPath)).deleted;
    // Drop the tracked snapshot too, so a retired flow isn't restored on next generate.
    await removeApprovedSnapshot(testPath);
  }
  return { deleted: true, spec_deleted: specDeleted, test_path: testPath };
}

/* ---- Dismissed override relationships (advisory, non-destructive) ---- */

/**
 * The dashboard flags a newly-mined flow as `conflicts_with_approved` when it runs
 * the SAME journey as an approved baseline but expects a DIFFERENT outcome. That
 * signal is ambiguous — it is EITHER genuine drift (same request, changed SUT
 * behavior) OR two legitimately-distinct scenarios (different body/auth on the same
 * endpoint sequence, e.g. a happy 200 and a failure 401). "Dismiss relationship"
 * records that a specific pairing is the latter, so future mines stop flagging it.
 *
 * Kept in its OWN file, NOT in approvals.json: coverage.ts parses the approvals
 * `{ entries: [...] }` shape for the skip gate and must never see these
 * presentation-only records. A missing/malformed file is an empty set, never fatal.
 */
export interface DismissedRelationship {
  /** Normalized (sorted) pair of outcome-aware review ids that are NOT the same test. */
  review_ids: [string, string];
  dismissed_at?: string;
  dismissed_by?: string;
}

/** Order-independent key for a pair of review ids. */
function relationshipKey(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join("||");
}

/** Read dismissed pairings as a set of normalized pair keys. Empty when absent. */
export async function readDismissedRelationships(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const parsed = await storage.records.readJson<unknown>(
      "hitl/dismissed-relationships"
    );
    if (parsed === null) return set;
    const entries = Array.isArray((parsed as { dismissed?: unknown }).dismissed)
      ? (parsed as { dismissed: DismissedRelationship[] }).dismissed
      : [];
    for (const entry of entries) {
      const [a, b] = entry.review_ids ?? [];
      if (typeof a === "string" && typeof b === "string") {
        set.add(relationshipKey(a, b));
      }
    }
  } catch {
    return set; // malformed -> treated as empty, never fatal
  }
  return set;
}

/**
 * Persist that two review versions are distinct scenarios, not an override pair, so
 * `loadFlows` stops flagging the pairing as `conflicts_with_approved`. Idempotent:
 * re-dismissing the same pairing is a no-op. Touches NO spec and NO approval.
 */
export async function dismissRelationship(input: {
  review_id: string;
  baseline_review_id: string;
  dismissed_by?: string;
}): Promise<{ dismissed: true } | { dismissed: false; reason: "invalid" }> {
  const a = input.review_id?.trim();
  const b = input.baseline_review_id?.trim();
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) {
    return { dismissed: false, reason: "invalid" };
  }
  const records: DismissedRelationship[] = [];
  try {
    const parsed = await storage.records.readJson<{
      dismissed?: DismissedRelationship[];
    }>("hitl/dismissed-relationships");
    records.push(...(parsed?.dismissed ?? []));
  } catch {
    /* malformed -> start fresh, never fatal */
  }
  const key = relationshipKey(a, b);
  const exists = records.some(
    (r) => relationshipKey(r.review_ids?.[0] ?? "", r.review_ids?.[1] ?? "") === key
  );
  if (!exists) {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
    records.push({
      review_ids: [x, y],
      dismissed_at: new Date().toISOString(),
      dismissed_by: input.dismissed_by ?? "operator",
    });
    await storage.records.writeJson("hitl/dismissed-relationships", {
      dismissed: records,
    });
  }
  return { dismissed: true };
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

/** Persona inferred from a generated spec's folder (guest/customer/admin). */
function personaFromSpecPath(path: string): string {
  if (path.includes("/guest/")) return "guest_shopper";
  if (path.includes("/customer/")) return "registered_customer";
  if (path.includes("/admin/")) return "admin_operator";
  return "unknown";
}

/**
 * Extract ordered steps from a manifest/spec body plan, unwrapping the repaired
 * `{ baseline, agent_repair }` shape. Returns [] when no usable plan is present —
 * the fallback source of steps for a kept draft whose candidate file has rotated away.
 */
function stepsFromBodyPlan(bodyPlan: unknown): FlowStep[] {
  const plan =
    bodyPlan && typeof bodyPlan === "object" && "baseline" in bodyPlan
      ? (bodyPlan as { baseline?: unknown }).baseline
      : bodyPlan;
  const steps = (plan as { steps?: unknown } | null | undefined)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map((raw) => {
      const step = raw as { method?: unknown; endpoint?: unknown; expected_status?: unknown };
      if (typeof step.method !== "string" || typeof step.endpoint !== "string") return null;
      return {
        method: step.method,
        endpoint: step.endpoint,
        expected_status: typeof step.expected_status === "number" ? step.expected_status : 0,
      };
    })
    .filter((step): step is FlowStep => step !== null);
}

/**
 * Load the active review queue. The newest mine is authoritative for undecided
 * work; older candidate files provide first-seen metadata only. Terminal
 * decisions remain separately available as resolved history.
 *
 * Undecided drafts that exist on disk but were NOT re-surfaced by the latest mine
 * are KEPT and shown as `awaiting_review` "kept" flows (seen_in_latest_run=false),
 * so a re-mine overrides matching journeys in place, appends new ones, and keeps
 * dropped ones visible — never silently orphaning a generated spec.
 */
export async function loadFlows(): Promise<FlowsPayload> {
  const files = await candidateFiles();
  const latestFile = files.at(-1) ?? null;
  const observations = new Map<string, CandidateObservation>();
  let latestRunId: string | null = null;
  let latestGeneratedAt: string | null = null;
  let latestCandidates: RawCandidate[] = [];
  let order = 0;

  for (const file of files) {
    let doc: { run_id?: string; generated_at?: string; candidates?: RawCandidate[] };
    try {
      const bytes = await storage.blobs.get(file);
      if (bytes === null) continue;
      doc = JSON.parse(bytes.toString("utf8")) as typeof doc;
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

  const decisions = await readDecisionHistory();
  // Pairings the operator has marked "distinct scenarios, not an override" — used
  // below to suppress the advisory conflict flag for exactly those pairs.
  const dismissedRelationships = await readDismissedRelationships();
  const approvedSignatures = new Set(
    [...decisions.values()]
      .filter((entry) => entry.status === "approved")
      .map((entry) => entry.flow_signature)
  );
  const selected = selectBusinessScenarios(
    latestCandidates.map((candidate) => ({ ...candidate, steps: candidate.steps ?? [] })),
    approvedSignatures
  );
  const specs = await specsByReview();
  const repairs = await repairOutcomesBySignature();
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
      baseline &&
        baseline.status_signature !== outcome &&
        publicDecision === null &&
        !(baselineId && dismissedRelationships.has(relationshipKey(id, baselineId)))
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
              signature: baseline.flow_signature,
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

  // Kept drafts: undecided specs on disk that the latest mine did NOT re-surface.
  // They remain reviewable (approve/discard/delete) instead of lingering invisibly.
  // A representative or one of its variants already covers some review ids — skip those.
  const coveredReviewIds = new Set<string>(activeReviewIds);
  for (const flow of flows) {
    for (const variant of flow.variants) coveredReviewIds.add(variant.review_id);
  }
  for (const [id, spec] of specs) {
    if (coveredReviewIds.has(id)) continue;
    const decision = decisions.get(id);
    // A terminally-decided flow is surfaced elsewhere (approved history / prior
    // decisions); discarded drafts are unlinked on decision. Only truly undecided
    // drafts are "kept".
    if (decision) continue;
    const sep = id.indexOf(":");
    const sig = sep >= 0 ? id.slice(0, sep) : id;
    const observed = observations.get(id);
    const cand = observed?.candidate;
    const steps = cand?.steps ?? stepsFromBodyPlan(spec.bodyPlan);
    const outcome = statusSignature(steps) || (sep >= 0 ? id.slice(sep + 1) : "");
    const persona = cand?.persona ?? personaFromSpecPath(spec.path);
    const naming = selectBusinessScenarios([
      { signature: sig, flow_name: cand?.flow_name ?? "Kept draft", persona, steps },
    ]).representatives[0];
    const currentRouteKey = routeKey(persona, steps);
    const baseline = [...decisions.values()]
      .filter(
        (entry) =>
          entry.status === "approved" &&
          matchesExactJourney(entry, { flow_signature: sig, route_key: currentRouteKey })
      )
      .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))[0];
    const baselineId = baseline
      ? baseline.review_id ?? reviewId(sig, baseline.status_signature ?? "")
      : null;
    const conflicts = Boolean(
      baseline &&
        baseline.status_signature !== outcome &&
        !(baselineId && dismissedRelationships.has(relationshipKey(id, baselineId)))
    );
    const repair = repairs.get(sig);
    coveredReviewIds.add(id);
    activeReviewIds.add(id);
    flows.push({
      review_id: id,
      signature: sig,
      flow_name: naming?.scenario_name ?? cand?.flow_name ?? `Kept draft ${sig.slice(0, 8)}`,
      persona,
      attributes: {
        requires_auth: Boolean(cand?.attributes?.requires_auth),
        is_admin: cand?.attributes?.is_admin ?? persona === "admin_operator",
        has_errors: cand?.attributes?.has_errors ?? spec.path.includes("failure-path"),
      },
      priority: cand?.priority ?? "medium",
      support: cand?.support ?? 0,
      score: cand?.score ?? 0,
      step_count: steps.length,
      steps,
      assertion_fields: cand?.assertion_hints?.fields ?? [],
      source_sessions: cand?.source_sessions ?? [],
      test_path: spec.path,
      decision: null,
      covered: true,
      route_key: currentRouteKey,
      status_signature: outcome,
      lifecycle: "awaiting_review",
      conflicts_with_approved: conflicts,
      conflict_signatures: conflicts && baseline ? [baseline.flow_signature] : [],
      repaired_by_agent: spec.repairedByAgent,
      repair_attempts: repair?.result === "repaired" ? repair.attempts : null,
      spec_hash: spec.specHash,
      body_plan_hash: spec.bodyPlanHash,
      body_rule_sources: spec.bodyRuleSources,
      artifact_matches_approval: null,
      conflict_baselines:
        conflicts && baseline
          ? [{
              flow_name: baseline.flow_name ?? (naming?.scenario_name ?? "approved"),
              status_signature: baseline.status_signature ?? "",
            }]
          : [],
      active_baseline:
        baseline && baselineId && baselineId !== id
          ? {
              review_id: baselineId,
              signature: baseline.flow_signature,
              flow_name: baseline.flow_name ?? (naming?.scenario_name ?? "approved"),
              status_signature: baseline.status_signature ?? "",
              test_path: specs.get(baselineId)?.path ?? null,
              decided_at: baseline.decided_at,
            }
          : null,
      first_seen_run: observed?.firstSeenRun ?? null,
      last_seen_run: observed?.lastSeenRun ?? null,
      seen_in_latest_run: false,
      version_count: 1,
      versions: [
        {
          review_id: id,
          status_signature: outcome,
          lifecycle: "awaiting_review",
          test_path: spec.path,
          first_seen_run: observed?.firstSeenRun ?? null,
          last_seen_run: observed?.lastSeenRun ?? null,
        },
      ],
      family_key: naming?.family_key ?? id,
      variant_count: 1,
      variants: [
        {
          review_id: id,
          signature: sig,
          flow_name: naming?.scenario_name ?? cand?.flow_name ?? "Kept draft",
          support: cand?.support ?? 0,
          score: cand?.score ?? 0,
          step_count: steps.length,
          status_signature: outcome,
          is_representative: true,
        },
      ],
      not_generated_reason: null,
    });
  }

  // The approved baseline being overridden STAYS visible as its own approved row —
  // the conflicted flow is a separate row that overrides it only once approved. So
  // we deliberately do NOT hide the baseline from approved history here.
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
      steps: stepsFromRoute(decision.route_key, decision.status_signature),
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
    source_candidates: latestFile
      ? `services/behavior-engine/data/candidates/${latestFile.slice("candidates/".length)}.json`
      : null,
    generated_at: latestGeneratedAt,
    flows,
    prior_decisions: priorDecisions,
    counts,
  };
}
