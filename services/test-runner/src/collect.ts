/**
 * Persona, flow_name, and source_sessions are LIFTED from the Playwright
 * annotations the script-generator stamps (services/script-generator/src/emit.ts),
 * never reconstructed from the candidates file here — keep this a clean exported
 * type, do not leak Playwright reporter shapes past this module.
 *
 * `trace_id` does NOT exist upstream: behavior-engine candidates carry
 * `source_sessions` but no trace_id, and a step is only {method, endpoint,
 * expected_status}. It is therefore OPTIONAL on the normalized result — emitted
 * only if an annotation ever supplies one, never invented.
 */

import { readFileSync } from "node:fs";
import type { SchemaDiffEntry } from "../../golden/src/compare.js";
import type { ValueDiffEntry } from "../../golden/src/value/value-rules.js";

/* ---- Playwright JSON reporter shapes (only the fields we read) ---- */

interface PwAnnotation {
  type: string;
  description?: string;
}

interface PwAttachment {
  name: string;
  contentType?: string;
  body?: string;
  path?: string;
}

interface PwStep {
  title: string;
  duration?: number;
  error?: { message?: string };
  steps?: PwStep[];
}

interface PwTestResult {
  status?: string;
  duration?: number;
  annotations?: PwAnnotation[];
  attachments?: PwAttachment[];
  steps?: PwStep[];
  errors?: { message?: string }[];
  error?: { message?: string };
}

interface PwTest {
  projectName?: string;
  status?: string;
  annotations?: PwAnnotation[];
  results?: PwTestResult[];
}

interface PwSpec {
  title?: string;
  ok?: boolean;
  tests?: PwTest[];
}

interface PwSuite {
  title?: string;
  file?: string;
  suites?: PwSuite[];
  specs?: PwSpec[];
}

export interface PlaywrightJsonReport {
  suites?: PwSuite[];
}

/* ---- Normalized run result (report builder input) ---- */

export interface NormalizedStep {
  endpoint: string;
  method: string;
  expected_status: number | null;
  actual_status: number | null;
  status: "passed" | "failed" | "skipped" | "timedOut" | "interrupted";
  duration_ms: number;
  golden_diff: SchemaDiffEntry[] | null;
  /** Tier A value-level violations (ADR 0001), from the "golden-value-diff" attachment. */
  value_diff: ValueDiffEntry[] | null;
  failure_message: string | null;
  /**
   * Live response body excerpt (capped upstream), captured from the
   * "response-body" attachment the generated spec stamps before its status
   * assert. ADVISORY evidence for triage only — deliberately NOT propagated
   * into the deterministic report.json (it is dynamic/nondeterministic).
   * Optional; absent on fixtures and pre-capture runs.
   */
  response_body?: string | null;
}

export interface NormalizedTest {
  persona: string;
  flow_name: string;
  flow_signature: string | null;
  source_sessions: string[];
  /** Optional — never invented; emitted only if an annotation supplies one. */
  trace_id?: string | null;
  project: string;
  file: string;
  title: string;
  status: "passed" | "failed" | "skipped" | "timedOut" | "interrupted";
  duration_ms: number;
  steps: NormalizedStep[];
}

export interface RunTotals {
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface NormalizedRunResult {
  generated_at: string;
  totals: RunTotals;
  tests: NormalizedTest[];
}

/* ---- Parsing ---- */

function annotationValue(annotations: PwAnnotation[] | undefined, type: string): string | undefined {
  return annotations?.find((a) => a.type === type)?.description;
}

function parseSourceSessions(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Decode a base64-or-raw JSON-array attachment body; null if absent/malformed. */
function readJsonArrayAttachment<T>(attachments: PwAttachment[] | undefined, name: string): T[] | null {
  const att = attachments?.find((a) => a.name === name);
  if (!att?.body) return null;
  // The JSON reporter base64-encodes attachment bodies; decode then parse.
  let text = att.body;
  try {
    text = Buffer.from(att.body, "base64").toString("utf8");
  } catch {
    /* fall through to raw parse */
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function readGoldenDiff(attachments: PwAttachment[] | undefined): SchemaDiffEntry[] | null {
  return readJsonArrayAttachment<SchemaDiffEntry>(attachments, "golden-diff");
}

function readValueDiff(attachments: PwAttachment[] | undefined): ValueDiffEntry[] | null {
  return readJsonArrayAttachment<ValueDiffEntry>(attachments, "golden-value-diff");
}

/**
 * Decode the "response-body" attachments (one per request step, enveloped with
 * its step title) into an endpoint-title -> body-excerpt map. Multiple steps
 * hitting the same endpoint collide on last-wins; acceptable for advisory
 * triage. The body is dynamic, so it rides the normalized result only and never
 * reaches report.json.
 */
function readResponseBodies(attachments: PwAttachment[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const att of attachments ?? []) {
    if (att.name !== "response-body" || !att.body) continue;
    let text = att.body;
    try {
      text = Buffer.from(att.body, "base64").toString("utf8");
    } catch {
      /* fall through to raw parse */
    }
    try {
      const parsed = JSON.parse(text) as { endpoint?: unknown; body?: unknown };
      if (typeof parsed.endpoint === "string" && typeof parsed.body === "string") {
        out.set(parsed.endpoint, parsed.body);
      }
    } catch {
      /* skip malformed attachment */
    }
  }
  return out;
}

function normStatus(status: string | undefined): NormalizedStep["status"] {
  switch (status) {
    case "passed":
    case "failed":
    case "skipped":
    case "timedOut":
    case "interrupted":
      return status;
    default:
      return "skipped";
  }
}

const STEP_TITLE_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)$/;

function extractRequestSteps(result: PwTestResult): NormalizedStep[] {
  const goldenDiff = readGoldenDiff(result.attachments);
  const valueDiff = readValueDiff(result.attachments);
  const responseBodies = readResponseBodies(result.attachments);
  const out: NormalizedStep[] = [];
  for (const step of result.steps ?? []) {
    const m = STEP_TITLE_RE.exec(step.title);
    if (!m) continue;
    const failed = Boolean(step.error?.message);
    const normalized: NormalizedStep = {
      endpoint: step.title,
      method: m[1],
      expected_status: expectedFromStepError(step.error?.message),
      actual_status: actualFromStepError(step.error?.message),
      status: failed ? "failed" : "passed",
      duration_ms: step.duration ?? 0,
      golden_diff: goldenDiff,
      value_diff: valueDiff,
      failure_message: failed ? (step.error?.message ?? "").replace(ANSI_RE, "") || null : null,
    };
    const body = responseBodies.get(step.title);
    if (body !== undefined) normalized.response_body = body;
    out.push(normalized);
  }
  return out;
}

// Playwright's `expect(resp.status(), "...").toBe(200)` failure message embeds
// both the expected and received value as text; parsed out below into
// expected/actual status rather than surfacing a raw matcher dump. Returns null
// when the message is not a status-mismatch (e.g. a thrown extractPath error).

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function expectedFromStepError(message: string | undefined): number | null {
  if (!message) return null;
  const m = /Expected:\s*(\d{3})/.exec(message.replace(ANSI_RE, ""));
  return m ? Number(m[1]) : null;
}

function actualFromStepError(message: string | undefined): number | null {
  if (!message) return null;
  const m = /Received:\s*(\d{3})/.exec(message.replace(ANSI_RE, ""));
  return m ? Number(m[1]) : null;
}

function* iterateSpecs(suites: PwSuite[] | undefined, file: string): Generator<{ spec: PwSpec; file: string }> {
  for (const suite of suites ?? []) {
    const suiteFile = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      yield { spec, file: suiteFile };
    }
    yield* iterateSpecs(suite.suites, suiteFile);
  }
}

export function collect(report: PlaywrightJsonReport): NormalizedRunResult {
  const tests: NormalizedTest[] = [];

  for (const { spec, file } of iterateSpecs(report.suites, "")) {
    for (const pwTest of spec.tests ?? []) {
      // Annotations are stamped at the test level via test.info().annotations.push;
      // Playwright surfaces them on the test, and also copies onto each result.
      const result = pwTest.results?.[pwTest.results.length - 1];
      const annotations = pwTest.annotations ?? result?.annotations;

      const persona = annotationValue(annotations, "persona") ?? "unknown";
      const flowName = annotationValue(annotations, "flow_name") ?? spec.title ?? "unknown";
      const signature = annotationValue(annotations, "flow_signature") ?? null;
      const sourceSessions = parseSourceSessions(annotationValue(annotations, "source_sessions"));
      const traceId = annotationValue(annotations, "trace_id"); // optional, absent today

      // The per-RESULT status is the authoritative passed|failed|skipped|
      // timedOut|interrupted union. The TEST-level outcome (pwTest.status) is a
      // different vocabulary (expected|unexpected|flaky|skipped) and would
      // mis-map "unexpected" -> skipped, so it is only a fallback when there is
      // no result at all.
      const status = normStatus(result?.status ?? pwTest.status);
      const duration = result?.duration ?? 0;
      const steps = result ? extractRequestSteps(result) : [];

      const normalized: NormalizedTest = {
        persona,
        flow_name: flowName,
        flow_signature: signature,
        source_sessions: sourceSessions,
        project: pwTest.projectName ?? "unknown",
        file,
        title: spec.title ?? "unknown",
        status,
        duration_ms: duration,
        steps,
      };
      // Only attach trace_id when one is actually present — never invent one.
      if (traceId !== undefined) normalized.trace_id = traceId;

      tests.push(normalized);
    }
  }

  const totals: RunTotals = {
    executed: tests.length,
    passed: tests.filter((t) => t.status === "passed").length,
    failed: tests.filter((t) => t.status === "failed" || t.status === "timedOut" || t.status === "interrupted").length,
    skipped: tests.filter((t) => t.status === "skipped").length,
  };

  return {
    generated_at: new Date().toISOString(),
    totals,
    tests,
  };
}

export function collectFromFile(jsonPath: string): NormalizedRunResult {
  const report = JSON.parse(readFileSync(jsonPath, "utf8")) as PlaywrightJsonReport;
  return collect(report);
}
