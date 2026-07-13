import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFromFile, type NormalizedRunResult } from "../../../test-runner/src/collect.js";
import { PROJECTS, runPlaywright, type Target } from "../../../test-runner/src/run.js";
import type { Mutant, MutationMetrics, MutationResult } from "../types.js";
import { buildMetrics } from "../metrics.js";
import { classifyMutation } from "./detect.js";
import { buildEndpointSpecIndex } from "./endpoint-index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolvePath(__dirname, "..", "..");

export interface RunMutationEvaluationOptions {
  target: Target;
  mutants: Mutant[];
  proxyPort?: number;
  upstream?: string;
  log?: (line: string) => void;
}

interface HitResponse {
  hits?: Record<string, { applied?: number; not_applied?: number }>;
}

async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 5): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(5000),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
    }
  }
  throw lastError;
}

function emptyResult(): NormalizedRunResult {
  return {
    generated_at: new Date().toISOString(),
    totals: { executed: 0, passed: 0, failed: 0, skipped: 0 },
    tests: [],
  };
}

async function setActiveMutant(proxyUrl: string, mutant: Mutant | null): Promise<void> {
  const resp = await fetchWithRetry(`${proxyUrl}/__eval/mutant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutant),
  });
  if (!resp.ok) throw new Error(`proxy rejected mutant (${resp.status})`);
}

async function appliedCount(proxyUrl: string, mutant: Mutant): Promise<number> {
  const resp = await fetchWithRetry(`${proxyUrl}/__eval/hits`);
  if (!resp.ok) return 0;
  const body = (await resp.json()) as HitResponse;
  return body.hits?.[mutant.id]?.applied ?? 0;
}

async function runSuite(target: Target, directSpecPaths?: string[]): Promise<NormalizedRunResult> {
  const run = await runPlaywright({
    target,
    directSpecPaths,
    extraArgs: ["--workers=1"],
  });
  if (!existsSync(run.jsonReportPath)) {
    return emptyResult();
  }
  return collectFromFile(run.jsonReportPath);
}

function targetSupportsDirectSpecs(target: Target): boolean {
  return (PROJECTS as readonly string[]).includes(target);
}

function directSpecsForTarget(target: Target, specs: Set<string>): string[] | undefined {
  if (!targetSupportsDirectSpecs(target)) return undefined;
  return [...specs].filter((file) => file.startsWith(`${target}/`)).sort();
}

function baselineExecutability(result: NormalizedRunResult): number {
  return result.totals.executed > 0 ? result.totals.passed / result.totals.executed : 0;
}

async function waitForProxyHealthy(proxyUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${proxyUrl}/__eval/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return;
      lastError = `health returned ${resp.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`mutation proxy did not become healthy: ${lastError}`);
}

async function startProxyProcess(options: {
  upstream: string;
  port: number;
  log: (line: string) => void;
}): Promise<{ process: ChildProcess; url: string }> {
  const proxyUrl = `http://127.0.0.1:${options.port}`;
  const child = spawn("npx", ["tsx", "src/proxy/proxy.ts"], {
    cwd: SERVICE_ROOT,
    env: {
      ...process.env,
      EVAL_PROXY_CONTROL: "1",
      EVAL_PROXY_PORT: String(options.port),
      EVAL_PROXY_UPSTREAM: options.upstream,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) options.log(`    proxy: ${text}`);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) options.log(`    proxy error: ${text}`);
  });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) options.log(`    proxy exited with code ${code}`);
    if (signal) options.log(`    proxy exited from signal ${signal}`);
  });

  await waitForProxyHealthy(proxyUrl);
  return { process: child, url: proxyUrl };
}

async function stopProxyProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      resolve();
    }, 2000).unref();
  });
}

export async function runMutationEvaluation(options: RunMutationEvaluationOptions): Promise<MutationMetrics> {
  const log = options.log ?? ((line: string) => console.log(line));
  const originalBackendUrl = process.env.MEDUSA_BACKEND_URL;
  const upstream = options.upstream ?? originalBackendUrl ?? "http://localhost:9000";
  const port = options.proxyPort ?? Number(process.env.EVAL_PROXY_PORT ?? 9099);
  let proxy: { process: ChildProcess; url: string } | null = null;

  try {
    proxy = await startProxyProcess({ upstream, port, log });
    process.env.MEDUSA_BACKEND_URL = proxy.url;

    log("  Baseline run through mutation proxy:");
    await setActiveMutant(proxy.url, null);
    const baseline = await runSuite(options.target);
    const baselineClean = baseline.totals.executed > 0 && baseline.totals.failed === 0;
    if (!baselineClean) {
      log("    baseline is not green; mutation attribution aborted");
      return buildMetrics({
        target: options.target,
        baselineClean,
        executabilityRate: baselineExecutability(baseline),
        results: options.mutants.map((mutant) => ({
          mutant,
          verdict: "inconclusive",
          applied_count: 0,
          reason: "baseline not green",
        })),
      });
    }

    const endpointIndex = buildEndpointSpecIndex(baseline);
    const results: MutationResult[] = [];
    for (const mutant of options.mutants) {
      log(`  Mutant ${mutant.id} ${mutant.operator} ${mutant.endpoint}${mutant.path ? ` ${mutant.path}` : ""}:`);
      const specs = endpointIndex.get(mutant.endpoint);
      if (!specs || specs.size === 0) {
        results.push({
          mutant,
          verdict: "inconclusive",
          applied_count: 0,
          reason: "no baseline spec exercises endpoint",
        });
        log("    inconclusive (endpoint untested)");
        continue;
      }

      const directSpecPaths = directSpecsForTarget(options.target, specs);
      if (targetSupportsDirectSpecs(options.target) && (!directSpecPaths || directSpecPaths.length === 0)) {
        results.push({
          mutant,
          verdict: "inconclusive",
          applied_count: 0,
          reason: `no ${options.target} spec exercises endpoint`,
        });
        log("    inconclusive (no target-matching spec)");
        continue;
      }

      await setActiveMutant(proxy.url, mutant);
      const faultRun = await runSuite(options.target, directSpecPaths);
      const count = await appliedCount(proxy.url, mutant);
      await setActiveMutant(proxy.url, null);

      if (count === 0) {
        results.push({
          mutant,
          verdict: "inconclusive",
          applied_count: 0,
          reason: "mutant never applied",
        });
        log("    inconclusive (not applied)");
        continue;
      }

      const verdict = classifyMutation(mutant, faultRun, baseline);
      results.push({
        mutant,
        verdict: verdict.killed ? "killed" : "survived",
        catching_spec: verdict.catchingSpec ?? undefined,
        evidence: verdict.evidence ?? undefined,
        applied_count: count,
        reason: verdict.baselinePreexistingFailure ? "baseline already failed endpoint" : undefined,
      });
      log(`    ${verdict.killed ? "killed" : "survived"} (applied ${count})`);
    }

    return buildMetrics({
      target: options.target,
      baselineClean,
      executabilityRate: baselineExecutability(baseline),
      results,
    });
  } finally {
    if (originalBackendUrl === undefined) delete process.env.MEDUSA_BACKEND_URL;
    else process.env.MEDUSA_BACKEND_URL = originalBackendUrl;
    if (proxy) await stopProxyProcess(proxy.process);
  }
}
