import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  FileJson,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  RefreshCw,
  Route,
  ScrollText,
  ShieldCheck,
  Store,
} from "lucide-react";
import { ReviewView } from "./review/ReviewView.js";
import { ReportsView } from "./reports/ReportsView.js";
import "./styles.css";

type CheckState = "checking" | "online" | "offline";

type StatusCheck = {
  label: string;
  state: CheckState;
  detail: string;
};

const publishableApiKey = __MEDUSA_PUBLISHABLE_API_KEY__;
const adminEmail = __MEDUSA_ADMIN_EMAIL__;
const adminPassword = __MEDUSA_ADMIN_PASSWORD__;

function baseHeaders() {
  return {
    "Content-Type": "application/json",
    "x-session-id": "dashboard-status-session",
  };
}

async function checkHealth(): Promise<StatusCheck> {
  const response = await fetch("/medusa/health", { headers: baseHeaders() });
  return {
    label: "Medusa backend",
    state: response.ok ? "online" : "offline",
    detail: response.ok ? "Health endpoint responded" : `Health returned ${response.status}`,
  };
}

async function checkStore(): Promise<StatusCheck> {
  const response = await fetch("/medusa/store/products?limit=1", {
    headers: {
      ...baseHeaders(),
      ...(publishableApiKey ? { "x-publishable-api-key": publishableApiKey } : {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  const count = Array.isArray(body.products) ? body.products.length : 0;
  return {
    label: "Store API",
    state: response.ok ? "online" : "offline",
    detail: response.ok ? `${count} product sample returned` : `Store returned ${response.status}`,
  };
}

async function checkAdminAuth(): Promise<StatusCheck> {
  const response = await fetch("/medusa/auth/user/emailpass", {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
    }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    label: "Admin auth",
    state: response.ok && body.token ? "online" : "offline",
    detail: response.ok && body.token ? "Token issued" : `Auth returned ${response.status}`,
  };
}

function StatusCard({ check }: { check: StatusCheck }) {
  return (
    <article className={`status-card ${check.state}`}>
      <div>
        <p>{check.label}</p>
        <strong>{check.state}</strong>
      </div>
      <span>{check.detail}</span>
    </article>
  );
}

function App() {
  const [checks, setChecks] = useState<StatusCheck[]>([
    { label: "Medusa backend", state: "checking", detail: "Waiting for health" },
    { label: "Store API", state: "checking", detail: "Waiting for products" },
    { label: "Admin auth", state: "checking", detail: "Waiting for token" },
  ]);
  const [lastChecked, setLastChecked] = useState("Not checked yet");
  const [view, setView] = useState<"status" | "review" | "reports">("status");
  const [summary, setSummary] = useState<{
    flows?: { total: number; with_test: number; approved: number; discarded: number };
    report?: { executed: number; passed: number; failed: number; status: "green" | "red" } | null;
  }>({});

  useEffect(() => {
    fetch("/api/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setSummary(s))
      .catch(() => {});
  }, []);

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
          label: ["Medusa backend", "Store API", "Admin auth"][index],
          state: "offline",
          detail: result.reason instanceof Error ? result.reason.message : "Request failed",
        };
      })
    );
    setLastChecked(new Date().toLocaleTimeString());
  }

  useEffect(() => {
    void refreshChecks();
  }, []);

  const KIBANA_URL = "http://localhost:5601";
  const reportSub = summary.report
    ? `${summary.report.status.toUpperCase()} · ${summary.report.passed}/${summary.report.executed} passed`
    : "No run yet";
  const modules: Array<{
    label: string;
    icon: typeof ScrollText;
    sub: string;
    href?: string;
    onClick?: () => void;
  }> = [
    { label: "Logs", icon: ScrollText, sub: "Search & filter in Kibana", href: KIBANA_URL },
    { label: "Traffic generation", icon: Activity, sub: "View events in Kibana", href: KIBANA_URL },
    {
      label: "Behavior flows",
      icon: Route,
      sub: summary.flows ? `${summary.flows.total} discovered` : "Run behavior:mine",
      onClick: () => setView("review"),
    },
    {
      label: "Generated tests",
      icon: FlaskConical,
      sub: summary.flows ? `${summary.flows.with_test} generated` : "Run script-generator",
      onClick: () => setView("review"),
    },
    { label: "Reports", icon: FileJson, sub: reportSub, onClick: () => setView("reports") },
  ];

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div className="title-lockup">
          <LayoutDashboard size={26} aria-hidden="true" />
          <div>
            <p>Behavior Platform</p>
            <span>Last checked {lastChecked}</span>
          </div>
        </div>
        {view === "status" ? (
          <button type="button" onClick={refreshChecks} title="Refresh status checks">
            <RefreshCw size={16} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        ) : null}
      </header>

      <nav className="view-tabs" aria-label="Dashboard views">
        <button
          type="button"
          className={view === "status" ? "active" : ""}
          onClick={() => setView("status")}
        >
          <Gauge size={16} aria-hidden="true" />
          <span>Status</span>
        </button>
        <button
          type="button"
          className={view === "review" ? "active" : ""}
          onClick={() => setView("review")}
        >
          <Route size={16} aria-hidden="true" />
          <span>Flow Review</span>
        </button>
        <button
          type="button"
          className={view === "reports" ? "active" : ""}
          onClick={() => setView("reports")}
        >
          <FileJson size={16} aria-hidden="true" />
          <span>Reports</span>
        </button>
      </nav>

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
      ) : view === "reports" ? (
        <section className="review-section" aria-label="Test run reports">
          <div className="workbench-heading">
            <FileJson size={22} aria-hidden="true" />
            <h1>Test Run Reports</h1>
          </div>
          <p className="review-intro">
            Every <code>npm run test:all</code> run is archived under{" "}
            <code>reports/runs/</code>. Pick a run to view its self-contained report; the
            newest is selected by default.
          </p>
          <ReportsView />
        </section>
      ) : (
        <>
          <section className="status-grid" aria-label="System status">
            {checks.map((check) => (
              <StatusCard key={check.label} check={check} />
            ))}
          </section>

          <section className="quick-links" aria-label="Local links">
            <a href="http://localhost:9000/app" target="_blank" rel="noreferrer">
              <ShieldCheck size={20} aria-hidden="true" />
              <span>Medusa Admin</span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a href="http://localhost:8000" target="_blank" rel="noreferrer">
              <Store size={20} aria-hidden="true" />
              <span>Storefront</span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </section>

          <section className="workbench" aria-label="Platform modules">
            <div className="workbench-heading">
              <Gauge size={22} aria-hidden="true" />
              <h1>Platform Modules</h1>
            </div>
            <div className="module-grid">
              {modules.map(({ label, icon: Icon, sub, href, onClick }) =>
                href ? (
                  <a
                    key={label}
                    className="module-card actionable"
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon size={22} aria-hidden="true" />
                    <h2>{label}</h2>
                    <p>{sub}</p>
                  </a>
                ) : (
                  <button key={label} type="button" className="module-card actionable" onClick={onClick}>
                    <Icon size={22} aria-hidden="true" />
                    <h2>{label}</h2>
                    <p>{sub}</p>
                  </button>
                )
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
