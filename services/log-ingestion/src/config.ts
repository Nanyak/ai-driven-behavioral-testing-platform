import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// services/log-ingestion/src -> service root is one level up, repo root two more.
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface IngestConfig {
  esUrl: string;
  /** Index pattern to read raw logs from. */
  esIndex: string;
  /** Default lookback window (hours) when --from is omitted. */
  windowHours: number;
  /** Repo-root output directories. */
  sessionsDir: string;
  goldenDir: string;
}

export function loadConfig(): IngestConfig {
  return {
    esUrl: get("ELASTICSEARCH_URL", "http://localhost:9200").replace(/\/+$/, ""),
    esIndex: get("ELASTICSEARCH_INDEX", "behavior-logs-*"),
    windowHours: getInt("INGEST_WINDOW_HOURS", 24),
    sessionsDir: resolve(REPO_ROOT, "data", "sessions"),
    goldenDir: resolve(REPO_ROOT, "golden-responses"),
  };
}
