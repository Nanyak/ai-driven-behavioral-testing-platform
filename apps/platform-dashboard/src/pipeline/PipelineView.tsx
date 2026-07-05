import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  FlaskConical,
  Loader2,
  Pickaxe,
  Play,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  X,
} from "lucide-react";
import { usePipeline } from "./usePipeline.js";
import type { PipelineJob } from "./pipeline.js";

/** Counts + report summary the stages show as input/output context. */
interface Summary {
  flows: { total: number; with_test: number; awaiting_review: number; discovered: number };
  report: { executed: number; passed: number; failed: number; status: "green" | "red" | "invalid" } | null;
}

async function fetchSummary(): Promise<Summary | null> {
  try {
    const r = await fetch("/api/summary");
    if (!r.ok) return null;
    return (await r.json()) as Summary;
  } catch {
    return null;
  }
}

interface StageDef {
  job: PipelineJob;
  title: string;
  icon: typeof Play;
  blurb: string;
  /** Guarded (LLM cost / mutating) stages open a confirm before firing. */
  guarded?: boolean;
}

const STAGES: StageDef[] = [
  {
    job: "mine",
    title: "Mine flows",
    icon: Pickaxe,
    blurb: "Cluster ingested traffic into ranked behavior flows (test candidates).",
  },
  {
    job: "invariants:verify",
    title: "Invariants",
    icon: ShieldCheck,
    blurb:
      "Propose behavioral invariants (body-level oracles) for changed flows, and bake only those that held on the last trusted baseline run (reports/playwright/normalized.json).",
    guarded: true,
  },
  {
    job: "generate",
    title: "Generate tests",
    icon: Sparkles,
    blurb: "Turn the newest candidates into runnable Playwright specs (deterministic).",
  },
  {
    job: "repair",
    title: "Repair (agent)",
    icon: FlaskConical,
    blurb: "Escalate specs that don't reproduce their mined outcome to the Claude agent.",
    guarded: true,
  },
  {
    job: "test:all",
    title: "Run suite",
    icon: Play,
    blurb: "Execute the whole generated suite against the live SUT (test:all).",
  },
  {
    job: "triage",
    title: "Triage report",
    icon: Stethoscope,
    blurb: "Annotate the latest report with failure verdicts (offline heuristic or LLM).",
  },
];

export function PipelineView({ onViewReports }: { onViewReports: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const refreshSummary = useCallback(() => {
    void fetchSummary().then(setSummary);
  }, []);
  useEffect(refreshSummary, [refreshSummary]);

  // A finished mine/generate/repair changes candidates & specs — refresh the context.
  const { status, error, run, isRunning } = usePipeline(refreshSummary);

  const [minSupport, setMinSupport] = useState("");
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairOnly, setRepairOnly] = useState("");

  const activeJob = isRunning ? status?.job ?? null : null;

  const startStage = (job: PipelineJob) => {
    if (job === "mine") {
      const n = Number.parseInt(minSupport, 10);
      void run("mine", Number.isInteger(n) && n > 0 ? { minSupport: n } : undefined);
    } else if (job === "repair") {
      setRepairOpen(true);
    } else {
      void run(job);
    }
  };

  const confirmRepair = () => {
    const only = repairOnly.trim();
    void run("repair", only ? { only } : undefined);
    setRepairOpen(false);
  };

  return (
    <div className="pipeline">
      <p className="muted pipeline-context">
        {summary ? (
          <>
            <strong>{summary.flows.total}</strong> mined flow(s),{" "}
            <strong>{summary.flows.with_test}</strong> with a generated test
            {summary.report ? (
              <>
                {" "}· last run{" "}
                <span className={summary.report.status === "green" ? "ok" : "bad"}>
                  {summary.report.passed}/{summary.report.executed} passed
                </span>
              </>
            ) : null}
          </>
        ) : (
          "Loading pipeline context…"
        )}
      </p>

      <ol className="stage-list">
        {STAGES.map((stage, i) => {
          const Icon = stage.icon;
          const running = activeJob === stage.job;
          return (
            <li key={stage.job} className={`stage ${running ? "running" : ""}`}>
              <div className="stage-index">{i + 1}</div>
              <div className="stage-body">
                <div className="stage-head">
                  <Icon size={17} aria-hidden="true" />
                  <h3>{stage.title}</h3>
                  {stage.guarded ? (
                    <span className="stage-tag" title="Runs the Claude agent — LLM cost">
                      LLM · mutates specs
                    </span>
                  ) : null}
                </div>
                <p className="stage-blurb">{stage.blurb}</p>

                {stage.job === "mine" ? (
                  <label className="stage-param">
                    min-support
                    <input
                      type="number"
                      min={1}
                      placeholder="default"
                      value={minSupport}
                      disabled={isRunning}
                      onChange={(e) => setMinSupport(e.target.value)}
                    />
                  </label>
                ) : null}

                <div className="stage-actions">
                  <button
                    type="button"
                    className="run-button"
                    disabled={isRunning}
                    onClick={() => startStage(stage.job)}
                  >
                    {running ? (
                      <>
                        <Loader2 size={15} className="spin" aria-hidden="true" /> Running…
                      </>
                    ) : (
                      <>
                        <Play size={15} aria-hidden="true" /> Run
                      </>
                    )}
                  </button>
                  {stage.job === "test:all" || stage.job === "triage" ? (
                    <button type="button" className="run-view-report" onClick={onViewReports}>
                      View report
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {error ? <p className="review-action-error">{error}</p> : null}

      {status && status.output ? (
        <div className="stage-log">
          <div className="stage-log-head">
            <span>{status.job ?? "job"} output</span>
            {status.state === "passed" ? <span className="run-result passed">Passed</span> : null}
            {status.state === "failed" ? (
              <span className="run-result failed">Failed (exit {status.exit_code})</span>
            ) : null}
          </div>
          <pre className="run-output" aria-label="pipeline job output">
            {status.output.slice(-8000)}
          </pre>
        </div>
      ) : null}

      {repairOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm repair">
          <div className="modal">
            <div className="modal-head">
              <AlertTriangle size={18} aria-hidden="true" />
              <h3>Run the resolver agent?</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setRepairOpen(false)}
                aria-label="Cancel"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <p>
              This spawns the Claude CLI agent against the <strong>live SUT</strong>: it incurs LLM
              cost and rewrites the <em>arrange/setup</em> of specs that fail to reproduce their
              mined outcome. Assertions and approved flows are never touched.
            </p>
            <label className="stage-param wide">
              Scope to (optional) — a spec hash or path fragment
              <input
                type="text"
                placeholder="e.g. 9814b5a0bf73 or admin/"
                value={repairOnly}
                onChange={(e) => setRepairOnly(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="run-view-report" onClick={() => setRepairOpen(false)}>
                Cancel
              </button>
              <button type="button" className="run-button" onClick={confirmRepair}>
                <FlaskConical size={15} aria-hidden="true" /> Run repair
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
