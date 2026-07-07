/**
 * Arm a fault on the live Medusa SUT by recreating its process with a new
 * REGRESSION_DEMO value, then wait for it to come back healthy.
 *
 * The injector reads process.env per request, but a separate process's env only
 * changes on restart, so the harness recreates the container. This is a HOST
 * tool: it drives docker compose and therefore must run on the host, not inside
 * a sibling container. Both the restart command and the health probe are
 * overridable so a non-compose setup can plug in.
 *
 *   EVAL_RESTART_CMD    shell command to recreate the backend with the current
 *                       env (default: docker compose recreate of `medusa`).
 *   EVAL_HEALTH_URL     health endpoint to poll (default: <MEDUSA_BACKEND_URL>/health).
 *   EVAL_HEALTH_TIMEOUT_MS  max wait for healthy (default 120000).
 *   EVAL_SKIP_RESTART=1 skip restarting entirely (operator toggles the SUT by hand).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_RESTART_CMD =
  "docker compose up -d --force-recreate --no-deps medusa";

// The restart command (docker compose) must run where the compose file lives —
// the repo root — NOT the test-runner package dir that `npm --prefix` makes the
// process cwd. This dir is services/test-runner/src/eval, so the repo root is
// four levels up. `EVAL_COMPOSE_CWD` overrides for non-standard layouts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
function composeCwd(): string {
  return process.env.EVAL_COMPOSE_CWD ?? REPO_ROOT;
}

function backendUrl(): string {
  return process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000";
}

function healthUrl(): string {
  return process.env.EVAL_HEALTH_URL ?? `${backendUrl().replace(/\/$/, "")}/health`;
}

export function restartSkipped(): boolean {
  return process.env.EVAL_SKIP_RESTART === "1";
}

/** Poll the health endpoint until it returns ok or the timeout elapses. */
async function waitForHealthy(timeoutMs: number): Promise<boolean> {
  const url = healthUrl();
  const deadline = Date.now() + timeoutMs;
  // Give the recreated process a beat before the first probe so we don't race a
  // still-listening old process on the same port.
  await sleep(1000);
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  return false;
}

export interface RestartOutcome {
  ok: boolean;
  skipped: boolean;
  detail: string;
}

/**
 * Recreate the backend with `faultId` armed (or cleared when null), then wait for
 * health. Returns ok=false with a detail message on restart or health failure so
 * the harness can record the fault run as unmeasurable rather than crashing.
 */
export async function armBackend(faultId: string | null): Promise<RestartOutcome> {
  const timeoutMs = Number(process.env.EVAL_HEALTH_TIMEOUT_MS ?? 120_000);

  if (restartSkipped()) {
    // Operator manages the SUT; just confirm it's reachable in the desired state.
    const healthy = await waitForHealthy(Math.min(timeoutMs, 15_000));
    return {
      ok: healthy,
      skipped: true,
      detail: healthy
        ? `restart skipped; SUT healthy (expects REGRESSION_DEMO=${faultId ?? "<unset>"})`
        : "restart skipped; SUT not reachable at health endpoint",
    };
  }

  const cmd = process.env.EVAL_RESTART_CMD ?? DEFAULT_RESTART_CMD;
  const proc = spawnSync(cmd, {
    shell: true,
    cwd: composeCwd(),
    encoding: "utf8",
    env: { ...process.env, REGRESSION_DEMO: faultId ?? "" },
  });
  if (proc.status !== 0) {
    return {
      ok: false,
      skipped: false,
      detail: `restart command failed (exit ${proc.status}): ${(proc.stderr || proc.stdout || "").trim().slice(0, 500)}`,
    };
  }

  const healthy = await waitForHealthy(timeoutMs);
  return {
    ok: healthy,
    skipped: false,
    detail: healthy
      ? `backend recreated with REGRESSION_DEMO=${faultId ?? "<unset>"}`
      : `backend recreated but did not become healthy within ${timeoutMs}ms`,
  };
}
