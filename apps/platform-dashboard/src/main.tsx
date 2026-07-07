import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FileJson,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  Route,
  Sun,
  Workflow,
} from "lucide-react";
import { ReviewView } from "./review/ReviewView.js";
import { ReportsView } from "./reports/ReportsView.js";
import { TestRunnerView } from "./runner/TestRunnerView.js";
import { PipelineView } from "./pipeline/PipelineView.js";
import { OverviewView } from "./overview/OverviewView.js";
import { EvaluationView } from "./evaluation/EvaluationView.js";
import {
  CHECK_LABELS,
  checkAdminAuth,
  checkHealth,
  checkStore,
  type StatusCheck,
  type ViewKey,
} from "./shared.js";
import {
  applyTheme,
  persistTheme,
  resolveInitialTheme,
  type Theme,
} from "./theme.js";
import "./styles.css";

const NAV: Array<{ key: ViewKey; label: string; icon: typeof Route }> = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "review", label: "Flow Review", icon: Route },
  { key: "pipeline", label: "Pipeline", icon: Workflow },
  { key: "runner", label: "Test Runner", icon: PlayCircle },
  { key: "reports", label: "Reports", icon: FileJson },
  { key: "evaluation", label: "Evaluation", icon: Gauge },
];

function App() {
  const [checks, setChecks] = useState<StatusCheck[]>([
    { label: "Medusa backend", state: "checking", detail: "Waiting for health" },
    { label: "Store API", state: "checking", detail: "Waiting for products" },
    { label: "Admin auth", state: "checking", detail: "Waiting for token" },
  ]);
  const [lastChecked, setLastChecked] = useState("Not checked yet");
  const [view, setView] = useState<ViewKey>("overview");
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => resolveInitialTheme());

  // Idempotent under StrictMode: applyTheme only writes when the value differs.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      persistTheme(next);
      return next;
    });
  }

  async function refreshChecks() {
    setChecks((current) =>
      current.map((check) => ({ ...check, state: "checking", detail: "Checking now" }))
    );

    const next = await Promise.allSettled([checkHealth(), checkStore(), checkAdminAuth()]);
    setChecks(
      next.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        return {
          label: CHECK_LABELS[index],
          state: "offline" as const,
          detail: result.reason instanceof Error ? result.reason.message : "Request failed",
        };
      })
    );
    setLastChecked(new Date().toLocaleTimeString());
  }

  useEffect(() => {
    void refreshChecks();
  }, []);

  const heading = NAV.find((n) => n.key === view);

  return (
    <div className={`dashboard-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <nav className="sidebar" aria-label="Primary">
        <div className="sidebar-brand">
          <LayoutDashboard size={22} aria-hidden="true" />
          <strong>Behavior Platform</strong>
          <button
            type="button"
            className="sidebar-collapse"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} aria-hidden="true" />
            )}
          </button>
        </div>
        <div className="sidebar-nav">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={`sidebar-item ${view === key ? "active" : ""}`}
              aria-current={view === key ? "page" : undefined}
              aria-label={label}
              title={collapsed ? label : undefined}
              onClick={() => setView(key)}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>

      <main className="dashboard-main">
        <header className="dashboard-header">
          <div className="title-lockup">
            <div>
              <p>{heading?.label ?? "Overview"}</p>
              <span>Last checked {lastChecked}</span>
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? (
                <Sun size={16} aria-hidden="true" />
              ) : (
                <Moon size={16} aria-hidden="true" />
              )}
              <span>{theme === "dark" ? "Light" : "Dark"}</span>
            </button>
          </div>
        </header>

        {view === "review" ? (
          <section className="review-section" aria-label="HITL flow review">
            <div className="workbench-heading">
              <FlaskConical size={22} aria-hidden="true" />
              <h1>Discovered Flows &amp; Generated Tests</h1>
            </div>
            <p className="review-intro">
              Review emergent flows, exact Playwright source, and redacted request-body plans.
              Persona is derived from behavior, never assigned by hand. Approval binds the artifact
              hashes used by the runner and also feeds the mining skip gate.
            </p>
            <ReviewView />
          </section>
        ) : view === "pipeline" ? (
          <section className="review-section" aria-label="Authoring pipeline">
            <div className="workbench-heading">
              <Workflow size={22} aria-hidden="true" />
              <h1>Authoring Pipeline</h1>
            </div>
            <p className="review-intro">
              Drive the whole test-authoring loop from the browser — no CLI needed. Run each stage
              in order: <strong>Mine</strong> flows from ingested traffic, <strong>Generate</strong>{" "}
              Playwright specs, optionally <strong>Repair</strong> failing ones with the agent,{" "}
              <strong>Run</strong> the suite, then <strong>Triage</strong>. One job runs at a time;
              newly mined flows and generated tests appear under <strong>Flow Review</strong>.
            </p>
            <PipelineView onViewReports={() => setView("reports")} />
          </section>
        ) : view === "runner" ? (
          <section className="review-section" aria-label="Test runner">
            <div className="workbench-heading">
              <PlayCircle size={22} aria-hidden="true" />
              <h1>Test Runner</h1>
            </div>
            <p className="review-intro">
              Execute the generated Playwright suite against the live SUT. Pick a suite — the
              approved artifacts (<code>approved</code>), a single persona, or a happy/failure slice
              — and watch the output. Finished runs are archived in the <strong>Reports</strong>{" "}
              tab.
            </p>
            <TestRunnerView onViewReports={() => setView("reports")} />
          </section>
        ) : view === "reports" ? (
          <section className="review-section" aria-label="Test run reports">
            <div className="workbench-heading">
              <FileJson size={22} aria-hidden="true" />
              <h1>Test Run Reports</h1>
            </div>
            <p className="review-intro">
              Every test run is archived under <code>reports/runs/</code>. Pick a run to view its
              self-contained report; the newest is selected by default.
            </p>
            <ReportsView />
          </section>
        ) : view === "evaluation" ? (
          <section className="review-section" aria-label="Regression evaluation">
            <div className="workbench-heading">
              <Gauge size={22} aria-hidden="true" />
              <h1>Regression Evaluation</h1>
            </div>
            <p className="review-intro">
              We seed known backend faults (wrong status, missing field, wrong total, wrong order
              status) and measure how many the generated suite catches — plus baseline
              executability. Published by <code>npm run eval:regression</code>.
            </p>
            <EvaluationView />
          </section>
        ) : (
          <OverviewView
            checks={checks}
            lastChecked={lastChecked}
            onRefresh={refreshChecks}
            onNavigate={setView}
          />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
