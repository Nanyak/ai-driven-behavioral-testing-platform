// Theme management (R2). The *initial* theme is applied pre-paint by an inline
// script in index.html (see applyInitialTheme) to avoid FOUC; this module is the
// React-side controller that reads/writes the same source of truth.

export type Theme = "light" | "dark";

const STORAGE_KEY = "behavior-dashboard-theme";

/** Resolve the theme to use on first load: stored choice wins, else OS preference. */
export function resolveInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be unavailable (private mode / sandbox) — fall through.
  }
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

/** Idempotently reflect the theme onto <html data-theme>. Safe under StrictMode. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (root.getAttribute("data-theme") !== theme) {
    root.setAttribute("data-theme", theme);
  }
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // best-effort
  }
}

export { STORAGE_KEY };
