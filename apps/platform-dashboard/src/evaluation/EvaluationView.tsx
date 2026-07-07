// Regression-evaluation view: KPI strip from GET /api/eval + the rendered
// metrics report embedded from /api/eval/view (same iframe pattern as Reports).
// Published by `npm run eval:regression` (services/test-runner/src/eval), which
// seeds known backend faults and measures the suite's detection rate.
import { useEffect, useState } from "react";
import { ExternalLink, Gauge } from "lucide-react";
import { EmptyState, Skeleton } from "../ui/primitives.js";

interface EvalSummary {
  generated_at: string | null;
  target: string | null;
  regression_detection_rate: number;
  measurable_faults: number;
  caught: number;
  executability_rate: number | null;
  baseline_clean: boolean | null;
}

const EVAL_VIEW_URL = "/api/eval/view";

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "no run yet";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function EvaluationView() {
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setState("loading");
    setError(null);
    try {
      const resp = await fetch("/api/eval");
      if (!resp.ok) throw new Error(`/api/eval returned ${resp.status}`);
      const body = (await resp.json()) as { summary: EvalSummary | null };
      setSummary(body.summary);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load evaluation");
      setState("error");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (state === "loading") return <Skeleton height={220} />;

  if (state === "error") {
    return (
      <EmptyState icon={<Gauge size={20} aria-hidden="true" />}>
        <strong>Could not load evaluation</strong>
        <p className="muted">{error ?? "Unknown error"}</p>
      </EmptyState>
    );
  }

  if (!summary) {
    return (
      <EmptyState icon={<Gauge size={20} aria-hidden="true" />}>
        <strong>No evaluation run yet</strong>
        <p className="muted">
          Run <code>npm run eval:regression -- --target customer</code> to seed known faults and
          measure how many the suite catches.
        </p>
      </EmptyState>
    );
  }

  const detected = summary.regression_detection_rate >= 1 && summary.measurable_faults > 0;

  return (
    <div className="eval-view">
      <div className="eval-kpis">
        <div className="eval-kpi">
          <span className="eval-kpi-label">Regression detection</span>
          <span className={`eval-kpi-value ${detected ? "t-pass" : "t-fail"}`}>
            {pct(summary.regression_detection_rate)}
          </span>
          <span className="muted">
            {summary.caught}/{summary.measurable_faults} seeded faults caught
          </span>
        </div>
        <div className="eval-kpi">
          <span className="eval-kpi-label">Executability</span>
          <span className="eval-kpi-value">{pct(summary.executability_rate)}</span>
          <span className="muted">
            baseline {summary.baseline_clean === false ? "not green" : "clean"}
          </span>
        </div>
        <div className="eval-kpi">
          <span className="eval-kpi-label">Suite / run</span>
          <span className="eval-kpi-value eval-kpi-target">{summary.target ?? "—"}</span>
          <span className="muted">{formatWhen(summary.generated_at)}</span>
        </div>
      </div>

      <div className="report-viewer">
        <div className="report-viewer-bar">
          <span className="muted">
            <Gauge size={13} aria-hidden="true" /> Regression evaluation report
          </span>
          <a href={EVAL_VIEW_URL} target="_blank" rel="noreferrer" className="report-open">
            Open in new tab <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
        <iframe title="regression evaluation metrics" src={EVAL_VIEW_URL} className="report-frame" />
      </div>
    </div>
  );
}
