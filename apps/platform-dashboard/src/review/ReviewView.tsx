import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Code2,
  FileCode2,
  FlaskConical,
  HelpCircle,
  History,
  ListTree,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { useFlows } from "./useFlows.js";
import { EmptyState, Skeleton } from "../ui/primitives.js";
import {
  fetchArtifactReview,
  fetchRepairDiff,
  type ArtifactReview as ArtifactReviewPayload,
  type Decision,
  type Lifecycle,
  type PriorDecision,
  type RepairDiff,
  type ReviewFlow,
} from "./decisions.js";
import { usePipeline } from "../pipeline/usePipeline.js";
import type { JobStatus } from "../pipeline/pipeline.js";

/** The 12-hex spec hash a repair run scopes to, from `…/<hash>.spec.ts`. */
function specHash(testPath: string): string {
  return testPath.split("/").pop()?.replace(/\.spec\.ts$/, "") ?? testPath;
}

interface RepairTarget {
  signature: string;
  hash: string;
  flowName: string;
}

const PERSONA_LABELS: Record<string, string> = {
  guest_shopper: "Guest Shopper",
  registered_customer: "Registered Customer",
  admin_operator: "Admin Operator",
};

function personaLabel(persona: string): string {
  return PERSONA_LABELS[persona] ?? persona;
}

const LIFECYCLE_META: Record<
  Lifecycle,
  { label: string; icon: typeof CheckCircle2; cls: string; hint: string }
> = {
  awaiting_review: {
    label: "Awaiting review",
    icon: FlaskConical,
    cls: "awaiting",
    hint: "A test was generated for this flow but no one has decided yet — this is what's new to review.",
  },
  discovered: {
    label: "Discovered",
    icon: CircleDashed,
    cls: "discovered",
    hint: "Mined as a candidate but no test was generated (e.g. capped out at 10/persona).",
  },
  approved: {
    label: "Approved",
    icon: CheckCircle2,
    cls: "approved",
    hint: "A human blessed this flow. It's kept and won't be re-mined as a new candidate.",
  },
  discarded: {
    label: "Discarded",
    icon: XCircle,
    cls: "discarded",
    hint: "A human rejected this flow. It won't re-surface as a candidate on the next mine.",
  },
};

// Conflicts first (need attention), then new work, then resolved.
const LIFECYCLE_ORDER: Record<Lifecycle, number> = {
  awaiting_review: 1,
  discovered: 2,
  approved: 3,
  discarded: 4,
};

type StatusFilter = "all" | "attention" | "awaiting_review" | "approved" | "discarded";
type PersonaFilter = "all" | "guest_shopper" | "registered_customer" | "admin_operator";

function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  const meta = LIFECYCLE_META[lifecycle];
  const Icon = meta.icon;
  return (
    <span className={`lifecycle-badge ${meta.cls}`} title={meta.hint}>
      <Icon size={13} aria-hidden="true" /> {meta.label}
    </span>
  );
}

function ConflictChip() {
  return (
    <span
      className="lifecycle-badge conflict"
      title="Same journey as an approved flow but expects a different outcome — likely drift/regression."
    >
      <AlertTriangle size={13} aria-hidden="true" /> conflicts
    </span>
  );
}

function ArtifactMismatchChip() {
  return (
    <span
      className="lifecycle-badge conflict"
      title="The current source or body plan no longer matches the approved hash and is quarantined."
    >
      <AlertTriangle size={13} aria-hidden="true" /> artifact changed
    </span>
  );
}

function AgentBadge({ attempts }: { attempts?: number | null }) {
  return (
    <span
      className="lifecycle-badge agent"
      title={
        "The on-disk spec's arrange/setup was repaired by the resolver-agent so it reproduces the mined outcome. " +
        "Assertions are unchanged (oracle-guarded). Approve to bless it as the baseline."
      }
    >
      <Wrench size={13} aria-hidden="true" /> agent-repaired
      {typeof attempts === "number" ? ` ·${attempts}` : ""}
    </span>
  );
}

type DiffLine = { type: "ctx" | "add" | "del"; text: string };

/** Minimal LCS-based unified diff over lines — small enough for a spec file. */
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

/** Collapse long runs of unchanged context so the reviewer sees only what changed. */
function collapseContext(lines: DiffLine[], pad = 2): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type === "ctx") return;
    for (let k = Math.max(0, idx - pad); k <= Math.min(lines.length - 1, idx + pad); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipping = false;
  for (let idx = 0; idx < lines.length; idx++) {
    if (keep[idx]) {
      out.push(lines[idx]);
      skipping = false;
    } else if (!skipping) {
      out.push({ type: "ctx", text: "  ⋮" });
      skipping = true;
    }
  }
  return out;
}

function RepairedDiff({ flow }: { flow: ReviewFlow }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<RepairDiff | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error" | "empty">("idle");

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && diff === null && loadState === "idle") {
      setLoadState("loading");
      try {
        const d = await fetchRepairDiff(flow.signature);
        if (d) {
          setDiff(d);
          setLoadState("idle");
        } else {
          setLoadState("empty");
        }
      } catch {
        setLoadState("error");
      }
    }
  }

  const rendered = diff ? collapseContext(lineDiff(diff.before, diff.after)) : [];
  const additions = rendered.filter((line) => line.type === "add").length;
  const deletions = rendered.filter((line) => line.type === "del").length;

  return (
    <section className="repair-diff">
      <button type="button" className="prior-toggle" onClick={() => void toggle()}>
        <Wrench size={14} aria-hidden="true" />
        <span>What the agent changed{diff ? ` (${diff.attempts} attempt${diff.attempts === 1 ? "" : "s"})` : ""}</span>
        <span className="how-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="repair-diff-body">
          {loadState === "loading" ? <p className="muted">Loading diff…</p> : null}
          {loadState === "error" ? <p className="muted">Could not load the repair diff.</p> : null}
          {loadState === "empty" ? (
            <p className="muted">
              Historical diff unavailable. This repair predates persistent diff history, or its
              stored snapshot was removed.
            </p>
          ) : null}
          {diff ? (
            <>
              <p className="muted">
                Arrange/setup only — assertions and expected statuses are oracle-guarded and
                identical on both sides.
              </p>
              <div className="repair-diff-summary" aria-label="Repair diff summary">
                <span className="add">+{additions} added</span>
                <span className="del">−{deletions} removed</span>
                <span className="guarded"><ShieldCheck size={12} aria-hidden="true" /> oracle unchanged</span>
              </div>
              <pre className="repair-diff-pre">
                {rendered.map((l, idx) => (
                  <div key={idx} className={`dl ${l.type}`}>
                    <span className="dl-mark">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                    {l.text}
                  </div>
                ))}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function shortDigest(value: string | null): string {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "unavailable";
}

function ArtifactReview({ flow }: { flow: ReviewFlow }) {
  const [open, setOpen] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactReviewPayload | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error" | "empty">("idle");

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && artifact === null && loadState === "idle") {
      setLoadState("loading");
      try {
        const payload = await fetchArtifactReview(flow.signature);
        if (payload) {
          setArtifact(payload);
          setLoadState("idle");
        } else {
          setLoadState("empty");
        }
      } catch {
        setLoadState("error");
      }
    }
  }

  const stateLabel =
    artifact?.matches_approval === true
      ? "Exact approved artifact"
      : artifact?.matches_approval === false
        ? "Changed since approval"
        : "Draft artifact";
  const bodyPlanForEvidence =
    artifact?.body_plan &&
    typeof artifact.body_plan === "object" &&
    "baseline" in artifact.body_plan
      ? (artifact.body_plan as { baseline?: unknown }).baseline
      : artifact?.body_plan;
  const selectedOptionals =
    bodyPlanForEvidence &&
    typeof bodyPlanForEvidence === "object" &&
    Array.isArray((bodyPlanForEvidence as { steps?: unknown }).steps)
      ? (
          (bodyPlanForEvidence as {
            steps: Array<{
              method?: string;
              endpoint?: string;
              selected_optional_fields?: string[];
            }>;
          }).steps
        ).flatMap((step) =>
          (step.selected_optional_fields ?? []).map((path) => ({
            step: `${step.method ?? ""} ${step.endpoint ?? ""}`.trim(),
            path,
          }))
        )
      : [];

  return (
    <section className="artifact-review">
      <button
        type="button"
        className="prior-toggle"
        onClick={() => void toggle()}
        aria-expanded={open}
      >
        <Code2 size={14} aria-hidden="true" />
        <span>Review executable artifact</span>
        <span className="how-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="artifact-review-body">
          {loadState === "loading" ? <p className="muted">Loading source and body plan…</p> : null}
          {loadState === "error" ? <p className="review-action-error">Could not load the artifact.</p> : null}
          {loadState === "empty" ? <p className="muted">No generated artifact is available.</p> : null}
          {artifact ? (
            <>
              <div className={`artifact-integrity ${artifact.matches_approval === false ? "mismatch" : ""}`}>
                <strong>{stateLabel}</strong>
                <span>Spec SHA-256: <code>{shortDigest(artifact.spec_hash)}</code></span>
                <span>Body-plan SHA-256: <code>{shortDigest(artifact.body_plan_hash)}</code></span>
              </div>
              {artifact.body_plan_hash === null ? (
                <p className="review-action-error">
                  Body-plan manifest unavailable. Regenerate tests before approval.
                </p>
              ) : null}
              <div className="artifact-provenance" aria-label="Body rule provenance">
                {artifact.body_rule_sources.map((source) => (
                  <span key={source} className={`provenance-chip ${source}`}>{source}</span>
                ))}
              </div>
              {selectedOptionals.length > 0 ? (
                <div className="optional-evidence">
                  <strong>Evidence-selected optional fields</strong>
                  <ul>
                    {selectedOptionals.map((item) => (
                      <li key={`${item.step}:${item.path}`}>
                        <code>{item.path}</code>
                        <span>{item.step}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <details className="artifact-disclosure">
                <summary><ListTree size={14} aria-hidden="true" /> Redacted body plan</summary>
                <pre>{JSON.stringify(artifact.body_plan, null, 2)}</pre>
              </details>
              <details className="artifact-disclosure">
                <summary><FileCode2 size={14} aria-hidden="true" /> Complete Playwright source</summary>
                <pre>{artifact.source}</pre>
              </details>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`how-it-works ${open ? "open" : ""}`}>
      <button type="button" className="how-toggle" onClick={() => setOpen((v) => !v)}>
        <HelpCircle size={15} aria-hidden="true" />
        <span>How review works</span>
        <span className="how-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="how-body">
          <ul>
            <li>
              <strong>Tests are generated before you review them.</strong> The script-generator
              writes a draft Playwright spec for each mined flow automatically. Drafts are excluded
              from normal suite runs until approved.
            </li>
            <li>
              <strong>Approve</strong> = bind the exact spec and body-plan hashes as the runnable baseline.{" "}
              <strong>Discard</strong> = reject the flow. Both record your decision and stop
              the flow from re-surfacing as a new candidate on the next{" "}
              <code>behavior:mine</code> (the skip gate).
            </li>
            <li>
              If approved source changes later, its hash no longer matches and the runner quarantines
              it until you review and approve the new artifact. Use the explicit <code>drafts</code>{" "}
              target to exercise undecided specs.
            </li>
            <li>
              <strong>Persona is derived from observed behavior</strong>, never declared. A{" "}
              <em>conflict</em> flags a newly-scanned flow that takes the same journey as an
              already-approved one but expects a different outcome — your drift/regression cue.
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Status legend">
      {(Object.keys(LIFECYCLE_META) as Lifecycle[]).map((lc) => (
        <span key={lc} className="legend-item" title={LIFECYCLE_META[lc].hint}>
          <LifecycleBadge lifecycle={lc} />
        </span>
      ))}
      <span className="legend-item" title="Contradicts an approved baseline.">
        <ConflictChip />
      </span>
    </div>
  );
}

function RepairRunStatus({
  status,
  error,
  hash,
}: {
  status: JobStatus | null;
  error: string | null;
  hash: string;
}) {
  const output = status?.output ?? "";
  const running = (!status && !error) || status?.state === "running";
  const failed = status?.state === "failed" || Boolean(error);
  const repaired = status?.state === "passed" && /(?:^|\s)repaired\s+\d/m.test(output);
  const alreadyGreen = status?.state === "passed" && output.includes("already-green");

  const title = running
    ? "Verifying this draft"
    : failed
      ? "Repair stopped safely"
      : repaired
        ? "Repair applied and reverified"
        : alreadyGreen
          ? "No repair needed"
          : "Repair job finished";
  const detail = running
    ? "The exact draft is running against the live SUT. Claude is called only if its expected status sequence does not reproduce."
    : failed
      ? "No unverified rewrite was kept. The original draft and every oracle assertion remain intact."
      : repaired
        ? "Arrange/setup changed; expected statuses, golden checks, and business invariants stayed frozen. Review the diff before approval."
        : alreadyGreen
          ? "This flow already reproduces its mined outcome, so Claude was not called and the source was left unchanged."
          : "Review the job output before approving this artifact.";

  return (
    <section
      className={`repair-run-status ${running ? "running" : failed ? "failed" : "passed"}`}
      aria-live="polite"
      role={failed ? "alert" : "status"}
    >
      <div className="repair-run-head">
        {running ? (
          <Loader2 size={17} className="spin" aria-hidden="true" />
        ) : failed ? (
          <ShieldAlert size={17} aria-hidden="true" />
        ) : (
          <ShieldCheck size={17} aria-hidden="true" />
        )}
        <div>
          <strong>{title}</strong>
          <span>spec {hash}</span>
        </div>
      </div>
      <p>{error ?? detail}</p>
      {running ? (
        <ol className="repair-progress" aria-label="Repair stages">
          <li className="active">Verify baseline</li>
          <li>Repair setup if red</li>
          <li>Guard oracle and re-run</li>
        </ol>
      ) : null}
      {!running && output ? (
        <details className="repair-output">
          <summary>Repair job output</summary>
          <pre>{output.slice(-4000)}</pre>
        </details>
      ) : null}
    </section>
  );
}

function DetailPanel({
  flow,
  onDecide,
  onDelete,
  onRepair,
  pending,
  repairStatus,
  repairError,
  repairHash,
}: {
  flow: ReviewFlow;
  onDecide: (status: Decision) => void;
  onDelete: () => void;
  onRepair: () => void;
  pending: boolean;
  repairStatus: JobStatus | null;
  repairError: string | null;
  repairHash: string | null;
}) {
  const repairRunning = Boolean(
    repairHash && !repairError && (!repairStatus || repairStatus.state === "running")
  );
  return (
    <aside className="review-detail">
      <header>
        <h2>{flow.flow_name}</h2>
        <div className="detail-badges">
          {flow.conflicts_with_approved ? <ConflictChip /> : null}
          {flow.artifact_matches_approval === false ? <ArtifactMismatchChip /> : null}
          {flow.repaired_by_agent ? <AgentBadge attempts={flow.repair_attempts} /> : null}
          <LifecycleBadge lifecycle={flow.lifecycle} />
        </div>
      </header>
      <p className="review-detail-meta">
        <span>{personaLabel(flow.persona)}</span>
        <span>priority {flow.priority}</span>
        <span>support {flow.support}</span>
        <span>score {flow.score.toFixed(3)}</span>
        {flow.attributes.has_errors ? (
          <span className="error-flag">
            <ShieldAlert size={13} aria-hidden="true" /> has_errors
          </span>
        ) : null}
      </p>

      {flow.conflicts_with_approved ? (
        <div className="conflict-box">
          <p className="conflict-title">
            <AlertTriangle size={15} aria-hidden="true" /> Contradicts an approved baseline
          </p>
          <p>
            This flow runs the same journey as a flow you already approved, but expects a
            different outcome — likely drift or a regression. Expected statuses now:{" "}
            <code>{flow.status_signature || "—"}</code>.
          </p>
          <ul>
            {flow.conflict_baselines.map((base, i) => (
              <li key={`${base.flow_name}-${i}`}>
                approved: <strong>{base.flow_name}</strong> expected{" "}
                <code>{base.status_signature || "—"}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section>
        <h3>Steps ({flow.step_count})</h3>
        <ol className="review-steps">
          {flow.steps.map((step, index) => (
            <li key={`${step.method}-${step.endpoint}-${index}`}>
              <code>{step.method}</code> {step.endpoint}
              <span className="step-status">→ {step.expected_status}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3>Golden assertions ({flow.assertion_fields.length})</h3>
        {flow.assertion_fields.length === 0 ? (
          <p className="muted">No field-level assertions recommended.</p>
        ) : (
          <ul className="review-assertions">
            {flow.assertion_fields.map((field) => (
              <li key={field}>
                <code>{field}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Test &amp; provenance</h3>
        <p className="review-detail-meta">
          <span>{flow.source_sessions.length} source sessions</span>
          {flow.test_path ? (
            <span className="test-path">
              <FileCode2 size={13} aria-hidden="true" /> {flow.test_path}
            </span>
          ) : (
            <span className="muted">no generated test (nothing to run for this flow)</span>
          )}
        </p>
        <code className="signature">{flow.signature}</code>
      </section>

      {repairHash ? (
        <RepairRunStatus status={repairStatus} error={repairError} hash={repairHash} />
      ) : null}
      {flow.repaired_by_agent ? <RepairedDiff flow={flow} /> : null}
      {flow.test_path ? <ArtifactReview flow={flow} /> : null}

      <footer className="review-actions">
        <button
          type="button"
          className="approve"
          disabled={pending || repairRunning || !flow.test_path || !flow.body_plan_hash}
          title={
            !flow.test_path
              ? "No generated test to approve"
              : !flow.body_plan_hash
                ? "Regenerate tests to create the body-plan manifest before approval"
                : "Approve this exact spec and body-plan hash"
          }
          onClick={() => onDecide("approved")}
        >
          <CheckCircle2 size={16} aria-hidden="true" /> Approve
        </button>
        <button
          type="button"
          className="discard"
          disabled={pending || repairRunning}
          onClick={() => onDecide("discarded")}
        >
          <XCircle size={16} aria-hidden="true" /> Discard
        </button>
        <button
          type="button"
          className="repair-test"
          disabled={pending || repairRunning || !flow.test_path || flow.lifecycle === "approved"}
          title={
            !flow.test_path
              ? "No generated test to repair"
              : flow.lifecycle === "approved"
                ? "Approved flows are the source of truth — never auto-repaired"
                : "Run the resolver agent on this spec (LLM cost; rewrites arrange/setup only)"
          }
          onClick={onRepair}
        >
          {repairRunning ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : (
            <Wrench size={16} aria-hidden="true" />
          )}{" "}
          {repairRunning ? "Repairing…" : "Repair this flow"}
        </button>
        <button
          type="button"
          className="delete-test"
          disabled={pending || repairRunning || !flow.test_path}
          title={
            flow.test_path
              ? `Delete ${flow.test_path} from generated-tests/`
              : "No generated test to delete"
          }
          onClick={onDelete}
        >
          <Trash2 size={16} aria-hidden="true" /> Delete test
        </button>
      </footer>
      <p className="review-note">
        <strong>Approve</strong> stores the exact spec/body-plan hashes and admits that artifact to
        normal runs. <strong>Discard</strong> rejects it and keeps it out of normal runs.{" "}
        <strong>Delete test</strong> removes the draft file but records no decision.
      </p>
    </aside>
  );
}

function PriorDecisions({ prior }: { prior: PriorDecision[] }) {
  const [open, setOpen] = useState(false);
  if (prior.length === 0) {
    return null;
  }
  return (
    <div className={`prior-decisions ${open ? "open" : ""}`}>
      <button type="button" className="prior-toggle" onClick={() => setOpen((v) => !v)}>
        <History size={14} aria-hidden="true" />
        <span>Earlier decisions not in this scan ({prior.length})</span>
        <span className="how-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <ul className="prior-list">
          {prior.map((p) => (
            <li key={p.signature}>
              <span className={`lifecycle-badge ${p.status}`}>
                {p.status === "approved" ? (
                  <CheckCircle2 size={12} aria-hidden="true" />
                ) : (
                  <XCircle size={12} aria-hidden="true" />
                )}{" "}
                {p.status}
              </span>
              <span className="prior-name">{p.flow_name}</span>
              <span className="muted">{personaLabel(p.persona)}</span>
              <span className="muted">expected {p.status_signature || "—"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ReviewView() {
  const { data, state, error, reload, decide, removeTest } = useFlows();
  const [persona, setPersona] = useState<PersonaFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [repairConfirm, setRepairConfirm] = useState<RepairTarget | null>(null);
  const [repairTarget, setRepairTarget] = useState<RepairTarget | null>(null);
  const {
    status: pipelineStatus,
    error: pipelineError,
    run: runPipeline,
  } = usePipeline((finished) => {
    if (finished.job === "repair") void reload();
  });

  const flows = data?.flows ?? [];
  const prior = data?.prior_decisions ?? [];

  const visible = useMemo(() => {
    const filtered = flows.filter((flow) => {
      if (persona !== "all" && flow.persona !== persona) return false;
      if (errorsOnly && !flow.attributes.has_errors) return false;
      if (
        status === "attention" &&
        !(
          flow.lifecycle === "awaiting_review" ||
          flow.conflicts_with_approved ||
          flow.artifact_matches_approval === false
        )
      ) {
        return false;
      }
      if (status === "awaiting_review" && flow.lifecycle !== "awaiting_review") return false;
      if (status === "approved" && flow.lifecycle !== "approved") return false;
      if (status === "discarded" && flow.lifecycle !== "discarded") return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const ca = a.conflicts_with_approved || a.artifact_matches_approval === false ? 0 : 1;
      const cb = b.conflicts_with_approved || b.artifact_matches_approval === false ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const la = LIFECYCLE_ORDER[a.lifecycle];
      const lb = LIFECYCLE_ORDER[b.lifecycle];
      if (la !== lb) return la - lb;
      return b.score - a.score;
    });
  }, [flows, persona, status, errorsOnly]);

  const selectedFlow =
    visible.find((flow) => flow.signature === selected) ?? visible[0] ?? null;

  async function handleDecide(flow: ReviewFlow, decision: Decision) {
    setPending(true);
    setActionError(null);
    try {
      await decide(flow, decision);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save decision");
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(flow: ReviewFlow) {
    if (!flow.test_path) return;
    if (!window.confirm(`Delete ${flow.test_path}? This removes the spec file from disk.`)) {
      return;
    }
    setPending(true);
    setActionError(null);
    try {
      await removeTest(flow);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete test");
    } finally {
      setPending(false);
    }
  }

  async function handleRepair(flow: ReviewFlow) {
    if (!flow.test_path) return;
    setRepairConfirm({
      signature: flow.signature,
      hash: specHash(flow.test_path),
      flowName: flow.flow_name,
    });
  }

  function confirmRepair() {
    if (!repairConfirm) return;
    const target = repairConfirm;
    setRepairConfirm(null);
    setRepairTarget(target);
    setActionError(null);
    void runPipeline("repair", { only: target.hash });
  }

  if (state === "loading" && !data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Skeleton height={32} />
        <Skeleton height={64} />
        <Skeleton height={64} />
        <Skeleton height={64} />
      </div>
    );
  }

  if (state === "error") {
    return (
      <EmptyState icon={<FlaskConical size={28} aria-hidden="true" />}>
        <p>Could not load flows: {error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </EmptyState>
    );
  }

  if (flows.length === 0) {
    return (
      <div className="review-empty">
        <p>
          No discovered flows yet. Run the pipeline (<code>npm run traffic:generate</code> →{" "}
          <code>ingest:run</code> → <code>behavior:mine</code> →{" "}
          <code>script-generator:generate</code>), then refresh.
        </p>
        <PriorDecisions prior={prior} />
      </div>
    );
  }

  const personaOptions: PersonaFilter[] = [
    "all",
    "guest_shopper",
    "registered_customer",
    "admin_operator",
  ];
  const c = data?.counts;
  const statusOptions: Array<{ key: StatusFilter; label: string; n?: number }> = [
    { key: "all", label: "All", n: c?.total },
    {
      key: "attention",
      label: "Needs attention",
      n: (c?.awaiting_review ?? 0) + (c?.conflicts ?? 0) + (c?.stale_approvals ?? 0),
    },
    { key: "awaiting_review", label: "Awaiting review", n: c?.awaiting_review },
    { key: "approved", label: "Approved", n: c?.approved },
    { key: "discarded", label: "Discarded", n: c?.discarded },
  ];

  return (
    <div className="review">
      <HowItWorks />
      <Legend />

      <div className="review-toolbar">
        <div className="status-filter" role="group" aria-label="Filter by status">
          {statusOptions.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={status === opt.key ? "active" : ""}
              onClick={() => setStatus(opt.key)}
            >
              {opt.label}
              {typeof opt.n === "number" ? <span className="chip-count">{opt.n}</span> : null}
            </button>
          ))}
        </div>
        <div className="persona-filter" role="group" aria-label="Filter by persona">
          {personaOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={persona === option ? "active" : ""}
              onClick={() => setPersona(option)}
            >
              {option === "all" ? "All personas" : personaLabel(option)}
            </button>
          ))}
        </div>
        <label className="errors-toggle">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => setErrorsOnly(event.target.checked)}
          />
          has_errors only
        </label>
        <div className="review-counts">
          {c ? (
            <span>
              {c.conflicts} conflicts · {c.stale_approvals} changed · {c.awaiting_review} awaiting · {c.approved} approved ·{" "}
              {c.discarded} discarded · {c.covered}/{c.total} covered
            </span>
          ) : null}
          <button type="button" onClick={reload} title="Reload flows">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {actionError ? <p className="review-action-error">{actionError}</p> : null}

      <div className="review-layout">
        <div className="review-list-wrap">
          <ul className="review-list">
            {visible.map((flow) => (
              <li key={flow.signature}>
                <button
                  type="button"
                  className={`review-row ${
                    selectedFlow?.signature === flow.signature ? "selected" : ""
                  } ${flow.conflicts_with_approved ? "conflict" : ""}`}
                  onClick={() => setSelected(flow.signature)}
                >
                  <span className="review-row-name">{flow.flow_name}</span>
                  <span className="review-row-meta">
                    <span className={`persona-tag ${flow.persona}`}>
                      {personaLabel(flow.persona)}
                    </span>
                    <span className="muted">support {flow.support}</span>
                    <span className="muted">{flow.step_count} steps</span>
                    {flow.test_path ? (
                      <span className="muted">
                        <FileCode2 size={12} aria-hidden="true" /> test
                      </span>
                    ) : null}
                    {flow.attributes.has_errors ? (
                      <span className="error-flag">
                        <ShieldAlert size={12} aria-hidden="true" /> errors
                      </span>
                    ) : null}
                    {flow.conflicts_with_approved ? <ConflictChip /> : null}
                    {flow.artifact_matches_approval === false ? <ArtifactMismatchChip /> : null}
                    {flow.repaired_by_agent ? <AgentBadge attempts={flow.repair_attempts} /> : null}
                    <LifecycleBadge lifecycle={flow.lifecycle} />
                  </span>
                </button>
              </li>
            ))}
            {visible.length === 0 ? (
              <li className="muted review-list-empty">No flows match this filter.</li>
            ) : null}
          </ul>
          <PriorDecisions prior={prior} />
        </div>

        {selectedFlow ? (
          <DetailPanel
            key={selectedFlow.signature}
            flow={selectedFlow}
            pending={pending}
            onDecide={(decision) => handleDecide(selectedFlow, decision)}
            onDelete={() => handleDelete(selectedFlow)}
            onRepair={() => handleRepair(selectedFlow)}
            repairStatus={
              repairTarget?.signature === selectedFlow.signature &&
              pipelineStatus?.job === "repair"
                ? pipelineStatus
                : null
            }
            repairError={
              repairTarget?.signature === selectedFlow.signature ? pipelineError : null
            }
            repairHash={
              repairTarget?.signature === selectedFlow.signature ? repairTarget.hash : null
            }
          />
        ) : null}
      </div>

      {repairConfirm ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="repair-confirm-title"
          aria-describedby="repair-confirm-description"
        >
          <div className="modal repair-confirm-modal">
            <div className="modal-head">
              <Wrench size={18} aria-hidden="true" />
              <h3 id="repair-confirm-title">Repair this flow?</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setRepairConfirm(null)}
                aria-label="Cancel repair"
              >
                <XCircle size={17} aria-hidden="true" />
              </button>
            </div>
            <p id="repair-confirm-description">
              The exact draft for <strong>{repairConfirm.flowName}</strong> will run against the
              live SUT. Claude is called only if the mined status sequence does not reproduce.
            </p>
            <div className="repair-confirm-facts">
              <span><ShieldCheck size={14} aria-hidden="true" /> Assertions stay frozen</span>
              <span><Wrench size={14} aria-hidden="true" /> Arrange/setup only</span>
              <span><FileCode2 size={14} aria-hidden="true" /> {repairConfirm.hash}</span>
            </div>
            <p className="repair-cost-note">
              This may incur LLM cost. A failed or rejected rewrite is discarded automatically.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="run-view-report"
                onClick={() => setRepairConfirm(null)}
              >
                Cancel
              </button>
              <button type="button" className="run-button" onClick={confirmRepair}>
                <Wrench size={15} aria-hidden="true" /> Run repair
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
