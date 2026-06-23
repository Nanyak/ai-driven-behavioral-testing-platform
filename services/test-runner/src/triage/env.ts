/**
 * Env resolution for the triage agent, mirroring services/behavior-engine/src/
 * config/env.ts: precedence is process.env > service .env > repo-root .env, and
 * a BLANK value is treated as unset so an empty exported ANTHROPIC_API_KEY does
 * not shadow a real one in a .env file (which would silently drop triage to the
 * offline heuristic with no signal).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(SERVICE_ROOT, "..", "..");

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    vars[key] = value;
  }
  return vars;
}

const fileEnv: Record<string, string> = {
  ...parseEnvFile(resolve(REPO_ROOT, ".env")),
  ...parseEnvFile(resolve(SERVICE_ROOT, ".env")),
};

export function getEnv(key: string, fallback = ""): string {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  const fromFile = fileEnv[key];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return fallback;
}
