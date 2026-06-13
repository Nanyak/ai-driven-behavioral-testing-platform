import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// services/traffic-generator/src -> repository root is three levels up.
const SERVICE_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(SERVICE_ROOT, "..", "..");

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    vars[key] = value;
  }
  return vars;
}

// Precedence: process.env > service .env > repo-root .env.
const fileEnv: Record<string, string> = {
  ...parseEnvFile(resolve(REPO_ROOT, ".env")),
  ...parseEnvFile(resolve(SERVICE_ROOT, ".env")),
};

function get(key: string, fallback = ""): string {
  return process.env[key] ?? fileEnv[key] ?? fallback;
}

function getInt(key: string, fallback: number): number {
  const raw = get(key, "");
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export type MixProfile = "realistic" | "signal-rich" | "smoke";

/**
 * Relative weights over the situation taxonomy (plan §4). Values are relative —
 * they are normalized to the configured total session count, then floored
 * (plan §7). One key per taxonomy leaf.
 */
export interface Weights {
  bounce: number; // A1
  browse: number; // A2
  cartAbandon: number; // B1
  checkoutAbandon: number; // B2
  guestCheckout: number; // C1
  returningCheckout: number; // C2
  newCheckout: number; // C3 (holdout, LLM-only)
  orderStatus: number; // D1
  profileMgmt: number; // D2
  returns: number; // E
  adminCatalog: number; // F1
  adminFulfill: number; // F2
  adminRefund: number; // F3
  adminSupport: number; // F4
  edge: number; // G
}

/** Conditional event probabilities within a flow (plan §4.1). */
export interface EventProbs {
  search: number;
  filter: number;
  secondItem: number;
  thirdItem: number;
  updateItem: number;
  removeItem: number;
  promoAttempt: number;
  promoInvalid: number;
  dealSeeker: number;
  retryOn4xx: number;
  reorderDuringStatus: number;
  contaminate: number;
}

/** Minimum counts of key terminal flows, guaranteed by floor top-up (plan §7). */
export interface Floors {
  holdout: number;
  returningCheckout: number;
  guestCheckout: number;
  returns: number;
  linkedRefunds: number;
  promoSuccess: number;
}

export interface TrafficConfig {
  backendUrl: string;
  publishableKey: string;
  adminEmail: string;
  adminPassword: string;
  anthropicApiKey: string;
  llmModel: string;
  profile: MixProfile;
  totalSessions: number;
  accountPoolSize: number;
  weights: Weights;
  eventProbs: EventProbs;
  floors: Floors;
  /** Promo codes used by the deal-seeker event path (plan §4.1, §5). */
  validPromoCode: string;
  invalidPromoCode: string;
  concurrency: number;
}

/** Default realistic shape (plan §4). Counts shown there are this × N≈300. */
const REALISTIC_WEIGHTS: Weights = {
  bounce: 20,
  browse: 18,
  cartAbandon: 13,
  checkoutAbandon: 9,
  guestCheckout: 8,
  returningCheckout: 6,
  newCheckout: 2,
  orderStatus: 7,
  profileMgmt: 5,
  returns: 4,
  adminCatalog: 2,
  adminFulfill: 2,
  adminRefund: 1.5,
  adminSupport: 0.5,
  edge: 2,
};

/** Signal-rich: same shape, purchase/return/refund leaves boosted for mining. */
const SIGNAL_RICH_WEIGHTS: Weights = {
  ...REALISTIC_WEIGHTS,
  guestCheckout: 12,
  returningCheckout: 10,
  newCheckout: 4,
  returns: 7,
  adminFulfill: 4,
  adminRefund: 3,
};

const PROFILE_WEIGHTS: Record<MixProfile, Weights> = {
  realistic: REALISTIC_WEIGHTS,
  "signal-rich": SIGNAL_RICH_WEIGHTS,
  smoke: REALISTIC_WEIGHTS,
};

const PROFILE_DEFAULT_TOTAL: Record<MixProfile, number> = {
  realistic: 300,
  "signal-rich": 300,
  smoke: 40,
};

const PROFILE_DEFAULT_POOL: Record<MixProfile, number> = {
  realistic: 25,
  "signal-rich": 25,
  smoke: 6,
};

const DEFAULT_EVENT_PROBS: EventProbs = {
  search: 0.3,
  filter: 0.25,
  secondItem: 0.35,
  thirdItem: 0.15,
  updateItem: 0.25,
  removeItem: 0.15,
  promoAttempt: 0.25,
  promoInvalid: 0.45,
  dealSeeker: 0.3,
  retryOn4xx: 0.5,
  reorderDuringStatus: 0.2,
  contaminate: 0.08,
};

const DEFAULT_FLOORS: Floors = {
  holdout: 6,
  returningCheckout: 5,
  guestCheckout: 5,
  returns: 5,
  linkedRefunds: 5,
  promoSuccess: 3,
};

/** Smoke profile shrinks floors so a tiny run can still pass structurally. */
const SMOKE_FLOORS: Floors = {
  holdout: 2,
  returningCheckout: 2,
  guestCheckout: 2,
  returns: 1,
  linkedRefunds: 1,
  promoSuccess: 1,
};

function parseProfile(raw: string): MixProfile {
  if (raw === "signal-rich" || raw === "smoke" || raw === "realistic") {
    return raw;
  }
  return "realistic";
}

export function loadConfig(): TrafficConfig {
  const profile = parseProfile(get("MIX_PROFILE", "realistic"));
  return {
    backendUrl: get("MEDUSA_BACKEND_URL", "http://localhost:9000").replace(/\/+$/, ""),
    publishableKey: get("MEDUSA_PUBLISHABLE_API_KEY"),
    adminEmail: get("MEDUSA_ADMIN_EMAIL", "admin@example.com"),
    adminPassword: get("MEDUSA_ADMIN_PASSWORD", "change-me"),
    anthropicApiKey: get("ANTHROPIC_API_KEY"),
    llmModel: get("TRAFFIC_LLM_MODEL", "claude-haiku-4-5-20251001"),
    profile,
    totalSessions: getInt("TRAFFIC_TOTAL_SESSIONS", PROFILE_DEFAULT_TOTAL[profile]),
    accountPoolSize: getInt("ACCOUNT_POOL_SIZE", PROFILE_DEFAULT_POOL[profile]),
    weights: PROFILE_WEIGHTS[profile],
    eventProbs: DEFAULT_EVENT_PROBS,
    floors: profile === "smoke" ? SMOKE_FLOORS : DEFAULT_FLOORS,
    validPromoCode: get("TRAFFIC_VALID_PROMO", "SAVE10"),
    invalidPromoCode: get("TRAFFIC_INVALID_PROMO", "WELCOME10"),
    concurrency: getInt("TRAFFIC_CONCURRENCY", 5),
  };
}
