import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FileJson,
  FlaskConical,
  LayoutDashboard,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  Route,
  Sun,
} from "lucide-react";
import { ReviewView } from "./review/ReviewView.js";
import { ReportsView } from "./reports/ReportsView.js";
import { TestRunnerView } from "./runner/TestRunnerView.js";
import { OverviewView } from "./overview/OverviewView.js";
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
  { key: "runner", label: "Test Runner", icon: PlayCircle },
  { key: "reports", label: "Reports", icon: FileJson },
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
              Read-only review of emergent flows mined by the behavior engine and the Playwright
              tests generated by the script-generator. Persona is a derived label (never set by
              hand). Approve or discard each flow — the decision feeds the skip gate.
            </p>
            <ReviewView />
          </section>
        ) : view === "runner" ? (
          <section className="review-section" aria-label="Test runner">
            <div className="workbench-heading">
              <PlayCircle size={22} aria-hidden="true" />
              <h1>Test Runner</h1>
            </div>
            <p className="review-intro">
              Execute the generated Playwright suite against the live SUT. Pick a suite — the whole
              run (<code>all</code>), a single persona, or a happy/failure slice — and watch the
              output. Finished runs are archived in the <strong>Reports</strong> tab.
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
