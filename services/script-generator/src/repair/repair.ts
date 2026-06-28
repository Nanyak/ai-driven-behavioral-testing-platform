/**
 * Setup/arrange repair loop (plan §New module #5). For each emitted spec that
 * fails to reproduce its mined `status_signature`, escalate to the agent: build
 * the context bundle, get a rewritten spec with fixed prerequisites/path/auth/body
 * setup, REJECT it if it touched the oracle (oracle-guard), write it, and
 * RE-VERIFY against the live SUT. Loop up to N; keep the agent's version only
 * when it goes genuinely green, otherwise restore the deterministic original.
 *
 * This runs ONLY when opted in (run.ts `--repair`), against a known-good SUT — it
 * is baseline establishment, not a "keep tests green" autopilot. Approved/blessed
 * flows are never touched (their oracle is the source of truth).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadAugmentedSpecs } from "../../../golden/src/oas-source.js";
import type { OasSpecs } from "../resolve.js";
import { makeClaudeCliAgent, type RepairAgent } from "./agent.js";
import { checkOracleUnchanged } from "./oracle-guard.js";
import { buildRepairTask, renderRepairPrompt, type PrefetchSample, type SutInfo } from "./repair-task.js";
import { verifySpec, type StepOutcome } from "./verify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
const GENERATED_TESTS_DIR = resolvePath(REPO_ROOT, "generated-tests");
const REPAIR_REPORT = resolvePath(REPO_ROOT, "reports", "resolver-repair.json");

const PROVENANCE = "// repaired-by: resolver-agent";

/** Read SUT connection info for agent exploration. The script-generator process
 * doesn't auto-load .env, so fill from process.env first, then the repo-root .env,
 * then the same defaults the test-runner uses. */
function readSutInfo(): SutInfo {
  const fileEnv: Record<string, string> = {};
  const envPath = resolvePath(REPO_ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      fileEnv[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  const get = (k: string, fb: string): string => process.env[k] ?? fileEnv[k] ?? fb;
  return {
    baseUrl: get("MEDUSA_BACKEND_URL", "http://localhost:9000"),
    adminEmail: get("MEDUSA_ADMIN_EMAIL", "admin@medusa-test.com"),
    adminPassword: get("MEDUSA_ADMIN_PASSWORD", "supersecret"),
    publishableKey: get("MEDUSA_PUBLISHABLE_API_KEY", ""),
  };
}

/** GET a URL synchronously via curl; null on any non-zero exit (best-effort). */
function curlGet(url: string, headers: Record<string, string>): string | null {
  const args = ["-s", "-S", "--max-time", "20", url];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  const proc = spawnSync("curl", args, { encoding: "utf8", timeout: 25_000, maxBuffer: 8 * 1024 * 1024 });
  return proc.status === 0 ? proc.stdout : null;
}

/** The collection endpoint behind a failing step: "POST /admin/orders/{id}/cancel" -> "/admin/orders". */
function collectionPath(stepEndpoint: string): string | null {
  const sp = stepEndpoint.indexOf(" ");
  const path = sp >= 0 ? stepEndpoint.slice(sp + 1) : stepEndpoint;
  const brace = path.indexOf("/{");
  const base = brace >= 0 ? path.slice(0, brace) : path;
  return base.startsWith("/admin/") || base.startsWith("/store/") ? base : null;
}

/** Keep only the first few rows of the first array-valued key, capped, so the prompt stays lean. */
function trimSample(body: string, rows = 3, cap = 2000): string {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        return JSON.stringify({ ...obj, [key]: (obj[key] as unknown[]).slice(0, rows) }, null, 1).slice(0, cap);
      }
    }
    return JSON.stringify(obj).slice(0, cap);
  } catch {
    return body.slice(0, cap);
  }
}

/**
 * Pre-fetch a small live sample of the collection behind each distinct failing step
 * so the agent reasons from real current state instead of curl-paginating. Best-effort:
 * any failure just yields no sample (the agent still has its bounded curl fallback).
 */
function prefetchSamples(failures: StepOutcome[], sut: SutInfo): PrefetchSample[] {
  const out: PrefetchSample[] = [];
  const seen = new Set<string>();
  let adminToken: string | null | undefined;

  for (const f of failures) {
    const coll = collectionPath(f.endpoint);
    if (!coll || seen.has(coll)) continue;
    seen.add(coll);

    const headers: Record<string, string> = {};
    if (coll.startsWith("/admin/")) {
      if (adminToken === undefined) {
        const auth = spawnSync(
          "curl",
          ["-s", "-S", "--max-time", "20", "-X", "POST", `${sut.baseUrl}/auth/user/emailpass`,
            "-H", "content-type: application/json",
            "-d", JSON.stringify({ email: sut.adminEmail, password: sut.adminPassword })],
          { encoding: "utf8", timeout: 25_000 }
        );
        try {
          adminToken = auth.status === 0 ? ((JSON.parse(auth.stdout) as { token?: string }).token ?? null) : null;
        } catch {
          adminToken = null;
        }
      }
      if (!adminToken) continue;
      headers.Authorization = `Bearer ${adminToken}`;
    } else if (sut.publishableKey) {
      headers["x-publishable-api-key"] = sut.publishableKey;
    }

    const body = curlGet(`${sut.baseUrl}${coll}?limit=5`, headers);
    if (body) out.push({ endpoint: coll, sample: trimSample(body) });
  }
  return out;
}

export interface EmittedSpec {
  /** repo-relative to generated-tests/, e.g. admin/happy-path/9814b5a0bf73.spec.ts */
  relPath: string;
  flowName: string;
  /** lowercased flow signature (to skip approved flows). */
  signature: string;
  fixme: boolean;
}

export type RepairResultKind =
  | "already-green"
  | "repaired"
  | "unrepaired"
  | "rejected"
  | "skipped-fixme"
  | "skipped-approved"
  | "error";

export interface RepairOutcome {
  relPath: string;
  flowName: string;
  /** lowercased flow signature — lets the dashboard join this outcome to its flow. */
  signature: string;
  expectedSignature: string | null;
  result: RepairResultKind;
  attempts: number;
  violations: string[];
  finalFailures: { endpoint: string; expected: number | null; actual: number | null }[];
  /** Deterministic spec before setup/arrange repair (set only on `repaired`) — for the review diff. */
  beforeSource?: string;
  /** Agent setup/arrange-repaired spec after repair (set only on `repaired`) — for the review diff. */
  afterSource?: string;
}

export interface RunRepairOptions {
  /** lowercased flow signatures to skip (approved/blessed oracles). */
  approvedSignatures?: Set<string>;
  /** restrict to specs whose relPath contains one of these substrings (demo/scope). */
  only?: string[];
  maxAttempts?: number;
  agent?: RepairAgent;
  /** injected for tests; defaults to the real OAS. */
  specs?: OasSpecs;
}

function stampProvenance(source: string): string {
  if (source.includes(PROVENANCE)) return source;
  // Insert right after the status_signature header so the oracle headers stay grouped.
  const lines = source.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("// status_signature:"));
  const at = idx >= 0 ? idx + 1 : 0;
  lines.splice(at, 0, PROVENANCE);
  return lines.join("\n");
}

function briefFailures(failures: StepOutcome[]): RepairOutcome["finalFailures"] {
  return failures.map((f) => ({ endpoint: f.endpoint, expected: f.expected, actual: f.actual }));
}

/** Reject malformed model output before it can replace a runnable spec on disk. */
export function typescriptSyntaxViolations(source: string, fileName = "repaired.spec.ts"): string[] {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  return (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

function generatedSuiteTypecheckFailure(): string | null {
  const result = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
    cwd: GENERATED_TESTS_DIR,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status === 0) return null;
  return `${result.stdout || ""}${result.stderr || ""}`.trim().slice(-3000) ||
    "generated-tests TypeScript compilation failed";
}

/** Repair one spec end-to-end. Mutates the file on disk; restores the original on failure. */
function repairOne(
  spec: EmittedSpec,
  specs: OasSpecs,
  agent: RepairAgent,
  maxAttempts: number,
  sut: SutInfo
): RepairOutcome {
  const absPath = resolvePath(GENERATED_TESTS_DIR, spec.relPath);
  const original = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";

  const base: Omit<RepairOutcome, "result" | "attempts"> = {
    relPath: spec.relPath,
    flowName: spec.flowName,
    signature: spec.signature.toLowerCase(),
    expectedSignature: null,
    violations: [],
    finalFailures: [],
  };

  let verdict = verifySpec(spec.relPath, absPath);
  base.expectedSignature = verdict.expectedSignature;

  if (verdict.fixme) return { ...base, result: "skipped-fixme", attempts: 0 };
  if (!verdict.ran) {
    return {
      ...base,
      result: "error",
      attempts: 0,
      violations: [
        verdict.stdoutTail.trim().slice(-1000) || "verification did not produce a Playwright report",
      ],
    };
  }
  if (verdict.matched) return { ...base, result: "already-green", attempts: 0 };

  // Inline a live sample of each failing step's collection so the agent reasons from
  // real current state in ~2 turns instead of curl-paginating to find it.
  const prefetch = prefetchSamples(verdict.failures, sut);

  const violations: string[] = [];
  let attempts = 0;
  let rejectionFeedback = "";

  for (let i = 0; i < maxAttempts; i++) {
    attempts++;
    const currentSource = readFileSync(absPath, "utf8");
    const task = buildRepairTask(
      spec.relPath,
      spec.flowName,
      currentSource,
      verdict.expectedSignature,
      verdict.failures,
      verdict.stdoutTail,
      specs,
      prefetch,
      sut
    );

    let candidate: string;
    try {
      candidate = agent(
        `${renderRepairPrompt(task)}${rejectionFeedback
          ? `\n\n## Previous candidate rejection\n${rejectionFeedback}\nReturn a corrected full spec.`
          : ""}`
      );
    } catch (err) {
      violations.push(`agent error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    // Oracle guard against the DETERMINISTIC original (not the last attempt), so an
    // agent can't drift the oracle one step at a time across attempts.
    const check = checkOracleUnchanged(original, candidate);
    if (!check.ok) {
      violations.push(...check.violations);
      rejectionFeedback = check.violations.slice(0, 6).join("\n");
      continue; // reject this candidate, try again (do NOT write it)
    }
    const syntaxViolations = typescriptSyntaxViolations(candidate, spec.relPath);
    if (syntaxViolations.length > 0) {
      violations.push(...syntaxViolations.map((violation) => `TypeScript syntax: ${violation}`));
      rejectionFeedback = syntaxViolations
        .slice(0, 6)
        .map((violation) => `TypeScript syntax: ${violation}`)
        .join("\n");
      continue; // malformed model output must never replace the runnable draft
    }

    const stamped = stampProvenance(candidate);
    writeFileSync(absPath, stamped);
    const typecheckFailure = generatedSuiteTypecheckFailure();
    if (typecheckFailure) {
      const violation = `TypeScript compile gate: ${typecheckFailure}`;
      violations.push(violation);
      rejectionFeedback = violation;
      writeFileSync(absPath, original);
      continue;
    }
    verdict = verifySpec(spec.relPath, absPath);
    if (verdict.matched) {
      // Keep the before/after sources so the dashboard can show the review diff
      // (what the agent changed) even after a later deterministic regen.
      return {
        ...base,
        result: "repaired",
        attempts,
        violations,
        finalFailures: [],
        beforeSource: original,
        afterSource: stamped,
      };
    }
  }

  // Never went green (or every candidate was rejected) — restore the deterministic spec.
  writeFileSync(absPath, original);
  const result: RepairResultKind = violations.length > 0 && attempts === violations.length ? "rejected" : "unrepaired";
  return {
    ...base,
    result,
    attempts,
    violations,
    finalFailures: briefFailures(verdict.failures),
  };
}

export function runRepair(specsToConsider: EmittedSpec[], options: RunRepairOptions = {}): RepairOutcome[] {
  const approved = options.approvedSignatures ?? new Set<string>();
  const maxAttempts = options.maxAttempts ?? 3;
  // Default agent reasons from the inlined live samples and resolves state at run time
  // (the emitted query + re-verify do the selection). maxTurns is a CEILING, not a
  // budget that gets spent: a converging repair stops as soon as it emits, so a higher
  // cap never taxes the success path — it only bounds the cost of a non-converging /
  // unsatisfiable run. 20 gives hard, contended flows (e.g. the return lifecycle) room
  // to land; lower it per-run via REPAIR_MAX_TURNS if you want cheaper give-ups.
  const envTurns = Number(process.env.REPAIR_MAX_TURNS);
  const maxTurns = Number.isInteger(envTurns) && envTurns > 0 ? envTurns : 20;
  const agent = options.agent ?? makeClaudeCliAgent({ explore: true, maxTurns });
  const oas = options.specs ?? (loadAugmentedSpecs() as OasSpecs);
  const sut = readSutInfo();

  const targets = specsToConsider.filter((s) => {
    if (options.only && !options.only.some((sub) => s.relPath.includes(sub))) return false;
    return true;
  });

  const outcomes: RepairOutcome[] = [];
  for (const spec of targets) {
    const sig = spec.signature.toLowerCase();
    if (approved.has(sig)) {
      outcomes.push({
        relPath: spec.relPath,
        flowName: spec.flowName,
        signature: sig,
        expectedSignature: null,
        result: "skipped-approved",
        attempts: 0,
        violations: [],
        finalFailures: [],
      });
      continue;
    }
    if (spec.fixme) {
      outcomes.push({
        relPath: spec.relPath,
        flowName: spec.flowName,
        signature: sig,
        expectedSignature: null,
        result: "skipped-fixme",
        attempts: 0,
        violations: [],
        finalFailures: [],
      });
      continue;
    }
    outcomes.push(repairOne(spec, oas, agent, maxAttempts, sut));
  }

  writeRepairReport(outcomes);
  return outcomes;
}

function writeRepairReport(outcomes: RepairOutcome[]): void {
  mkdirSync(dirname(REPAIR_REPORT), { recursive: true });
  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.result] = (acc[o.result] ?? 0) + 1;
    return acc;
  }, {});
  writeFileSync(
    REPAIR_REPORT,
    JSON.stringify({ generated_at: new Date().toISOString(), summary, outcomes }, null, 2)
  );
}

export function printRepairSummary(outcomes: RepairOutcome[]): void {
  const by: Record<string, number> = {};
  for (const o of outcomes) by[o.result] = (by[o.result] ?? 0) + 1;
  console.log("\nSetup/arrange resolver-agent repair summary");
  for (const [k, v] of Object.entries(by)) console.log(`  ${k.padEnd(18)} ${v}`);
  for (const o of outcomes) {
    if (o.result === "repaired") console.log(`  ✓ repaired   ${o.relPath} (${o.attempts} attempt(s))`);
    if (o.result === "unrepaired" || o.result === "rejected" || o.result === "error")
      console.log(`  ✗ ${o.result.padEnd(10)} ${o.relPath} — ${o.violations.slice(0, 2).join("; ") || "still red"}`);
  }
  console.log(`\n  Report: ${REPAIR_REPORT}`);
}

/** Outcomes that mean the requested repair did not establish a runnable baseline. */
export function hasBlockingRepairOutcomes(outcomes: RepairOutcome[]): boolean {
  return outcomes.length === 0 ||
    outcomes.some((outcome) =>
      outcome.result === "error" ||
      outcome.result === "unrepaired" ||
      outcome.result === "rejected"
    );
}
