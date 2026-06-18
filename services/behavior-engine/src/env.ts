/**
 * Environment loading for the behavior engine.
 *
 * Mirrors the traffic generator's resolution (services/traffic-generator/src/
 * config/config.ts): precedence is `process.env` > service `.env` > repo-root
 * `.env`. This is why the LLM key works under `npm run mine` without exporting
 * it into the shell — drop it in `services/behavior-engine/.env` (gitignored)
 * and it is picked up here. With no key set anywhere, naming.ts degrades to a
 * deterministic offline fallback; the deterministic pipeline is unaffected.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// services/behavior-engine/src -> service root one up, repo root two more.
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

/** Resolve an env var, falling back through the file env then a default. */
export function getEnv(key: string, fallback = ""): string {
  return process.env[key] ?? fileEnv[key] ?? fallback;
}
