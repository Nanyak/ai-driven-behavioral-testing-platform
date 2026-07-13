import { useEffect, useState } from "react";
import { ExternalLink, Gauge } from "lucide-react";
import { EmptyState, Skeleton } from "../ui/primitives.js";

interface EvalSummary {
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
          Run <code>npm run eval:mutate -- --target customer</code> to measure mutation coverage.
        </p>
      </EmptyState>
    );
  }

  const strongScore = summary.mutation_score >= 0.8 && summary.total_mutants > 0;

  return (
    <div className="eval-view">
      <div className="eval-kpis">
        <div className="eval-kpi">
          <span className="eval-kpi-label">Mutation score</span>
          <span className={`eval-kpi-value ${strongScore ? "t-pass" : "t-fail"}`}>
            {pct(summary.mutation_score)}
          </span>
          <span className="muted">
            {summary.caught} killed / {summary.survived} survived
          </span>
        </div>
        <div className="eval-kpi">
          <span className="eval-kpi-label">Mutants</span>
          <span className="eval-kpi-value">{summary.total_mutants}</span>
          <span className="muted">
            {summary.inconclusive} inconclusive
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

      <div className="eval-survivors">
        <h2>Survivors</h2>
        {summary.survivors.length === 0 ? (
          <p className="muted">No surviving measurable mutants.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Operator</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {summary.survivors.slice(0, 12).map((survivor) => (
                <tr key={survivor.id}>
                  <td>
                    <code>{survivor.endpoint}</code>
                  </td>
                  <td>{survivor.status}</td>
                  <td>{survivor.operator}</td>
                  <td>
                    <code>{survivor.path ?? "<status>"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="report-viewer">
        <div className="report-viewer-bar">
          <span className="muted">
            <Gauge size={13} aria-hidden="true" /> Mutation evaluation report
          </span>
          <a href={EVAL_VIEW_URL} target="_blank" rel="noreferrer" className="report-open">
            Open in new tab <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
        <iframe title="mutation evaluation metrics" src={EVAL_VIEW_URL} className="report-frame" />
      </div>
    </div>
  );
}
