// Shared types + status-check probes, reused by the shell (main.tsx) and the
// Overview page. Endpoint shapes are unchanged — this is a refactor extraction.

export type ViewKey = "overview" | "review" | "runner" | "reports";

export type CheckState = "checking" | "online" | "offline";

export type StatusCheck = {
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

export const CHECK_LABELS = ["Medusa backend", "Store API", "Admin auth"] as const;

export async function checkHealth(): Promise<StatusCheck> {
  const response = await fetch("/medusa/health", { headers: baseHeaders() });
  return {
    label: "Medusa backend",
    state: response.ok ? "online" : "offline",
    detail: response.ok ? "Health endpoint responded" : `Health returned ${response.status}`,
  };
}

export async function checkStore(): Promise<StatusCheck> {
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

export async function checkAdminAuth(): Promise<StatusCheck> {
  const response = await fetch("/medusa/auth/user/emailpass", {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    label: "Admin auth",
    state: response.ok && body.token ? "online" : "offline",
    detail: response.ok && body.token ? "Token issued" : `Auth returned ${response.status}`,
  };
}
