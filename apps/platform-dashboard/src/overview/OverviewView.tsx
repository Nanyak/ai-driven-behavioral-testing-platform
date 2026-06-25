// R4 — Overview / Home: the default operator landing.
// Reuses the existing health checks + /api/summary pipeline strip + /api/reports
// trend (F1) + quick links + deep links into each section.
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  FileJson,
  FlaskConical,
  PlayCircle,
  RefreshCw,
  Route,
  ScrollText,
  ShieldCheck,
  Store,
} from "lucide-react";
import { Badge, Card, EmptyState, Skeleton } from "../ui/primitives.js";
import { TrendPanel } from "./Trend.js";
import { fetchReports, type ReportRow } from "../reports/reports.js";
import type { StatusCheck, ViewKey } from "../shared.js";

const KIBANA_URL = "http://localhost:5601";
const ADMIN_URL = "http://localhost:9000/app";
const STOREFRONT_URL = "http://localhost:8000";

type Summary = {
  flows?: {
    total: number;
    with_test: number;
    approved: number;
    discarded: number;
    awaiting_review?: number;
  };
  report?: { executed: number; passed: number; failed: number; status: "green" | "red" } | null;
};

function checkTone(state: StatusCheck["state"]): "ok" | "bad" | "warn" {
  if (state === "online") return "ok";
  if (state === "offline") return "bad";
  return "warn";
}

export function OverviewView({
  checks,
  lastChecked,
  onRefresh,
  onNavigate,
}: {
  checks: StatusCheck[];
  lastChecked: string;
  onRefresh: () => void;
  onNavigate: (view: ViewKey) => void;
}) {
  const [summary, setSummary] = useState<Summary>({});
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [reportsState, setReportsState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    fetch("/api/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setSummary(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    fetchReports()
      .then((rows) => {
        if (!alive) return;
        setReports(rows);
        setReportsState("ready");
      })
      .catch(() => alive && setReportsState("error"));
    return () => {
      alive = false;
    };
  }, []);

  const flows = summary.flows;
  const pipeline: Array<{ label: string; value: string; view?: ViewKey; tone?: "ok" | "warn" }> = [
    {
      label: "Flows discovered",
      value: flows ? String(flows.total) : "—",
      view: "review",
    },
    {
      label: "Awaiting review",
      value: flows?.awaiting_review != null ? String(flows.awaiting_review) : "—",
      view: "review",
      tone: flows?.awaiting_review ? "warn" : undefined,
    },
    { label: "Approved", value: flows ? String(flows.approved) : "—", view: "review", tone: "ok" },
    { label: "Tests generated", value: flows ? String(flows.with_test) : "—", view: "review" },
  ];

  return (
    <div className="overview">
      <section className="overview-status" aria-label="System status">
        {checks.map((check) => (
          <Card key={check.label} className={`status-card ${check.state}`}>
            <div>
              <p>{check.label}</p>
              <Badge tone={checkTone(check.state)}>{check.state}</Badge>
            </div>
            <span>{check.detail}</span>
          </Card>
        ))}
      </section>

      <section className="overview-grid">
        <Card className="panel">
          <div className="panel-head">
            <h2>Pipeline</h2>
            <button type="button" className="ui-btn-ghost" onClick={onRefresh} title="Refresh status checks">
              <RefreshCw size={14} aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>
          <div className="pipeline-strip">
            {pipeline.map((p) => (
              <button
                key={p.label}
                type="button"
                className="pipeline-stat"
                onClick={() => p.view && onNavigate(p.view)}
                disabled={!p.view}
              >
                <span className={`pipeline-value ${p.tone ?? ""}`}>{p.value}</span>
                <span className="pipeline-label">{p.label}</span>
              </button>
            ))}
          </div>
          {!flows ? (
            <p className="muted">
              No mined flows yet — run <code>behavior:mine</code> then <code>script-generator</code>.
            </p>
          ) : null}
        </Card>

        <Card className="panel">
          <div className="panel-head">
            <h2>Test trend</h2>
            <button
              type="button"
              className="ui-btn-ghost"
              onClick={() => onNavigate("reports")}
              title="Open Reports"
            >
              <FileJson size={14} aria-hidden="true" />
              <span>Reports</span>
            </button>
          </div>
          {reportsState === "loading" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Skeleton height={48} />
              <Skeleton height={96} />
            </div>
          ) : reportsState === "error" ? (
            <EmptyState>Could not load run history.</EmptyState>
          ) : (
            <TrendPanel reports={reports} />
          )}
        </Card>
      </section>

      <section className="quick-links" aria-label="Local links">
        <a href={ADMIN_URL} target="_blank" rel="noreferrer">
          <ShieldCheck size={20} aria-hidden="true" />
          <span>Medusa Admin</span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
        <a href={STOREFRONT_URL} target="_blank" rel="noreferrer">
          <Store size={20} aria-hidden="true" />
          <span>Storefront</span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
        <a href={KIBANA_URL} target="_blank" rel="noreferrer">
          <ScrollText size={20} aria-hidden="true" />
          <span>Kibana</span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </section>

      <section className="workbench" aria-label="Jump to sections">
        <div className="workbench-heading">
          <Route size={22} aria-hidden="true" />
          <h1>Sections</h1>
        </div>
        <div className="module-grid overview-modules">
          <button type="button" className="module-card actionable" onClick={() => onNavigate("review")}>
            <Route size={22} aria-hidden="true" />
            <h2>Flow Review</h2>
            <p>{flows ? `${flows.total} discovered` : "Review mined flows"}</p>
          </button>
          <button type="button" className="module-card actionable" onClick={() => onNavigate("runner")}>
            <PlayCircle size={22} aria-hidden="true" />
            <h2>Test Runner</h2>
            <p>Run the suite against the SUT</p>
          </button>
          <button type="button" className="module-card actionable" onClick={() => onNavigate("reports")}>
            <FileJson size={22} aria-hidden="true" />
            <h2>Reports</h2>
            <p>
              {summary.report
                ? `${summary.report.status.toUpperCase()} · ${summary.report.passed}/${summary.report.executed} passed`
                : "Archived run history"}
            </p>
          </button>
          <a className="module-card actionable" href={KIBANA_URL} target="_blank" rel="noreferrer">
            <FlaskConical size={22} aria-hidden="true" />
            <h2>Logs &amp; Traffic</h2>
            <p>Search events in Kibana</p>
          </a>
        </div>
      </section>
    </div>
  );
}
