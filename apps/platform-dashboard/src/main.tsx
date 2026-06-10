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
    "x-persona": "admin_operator",
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

  const placeholders = [
    { label: "Logs", icon: ScrollText },
    { label: "Traffic generation", icon: Activity },
    { label: "Behavior flows", icon: Route },
    { label: "Generated tests", icon: FlaskConical },
    { label: "Reports", icon: FileJson },
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
        <button type="button" onClick={refreshChecks} title="Refresh status checks">
          <RefreshCw size={16} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </header>

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
          {placeholders.map(({ label, icon: Icon }) => (
            <article key={label} className="module-card">
              <Icon size={22} aria-hidden="true" />
              <h2>{label}</h2>
              <p>Phase placeholder</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
