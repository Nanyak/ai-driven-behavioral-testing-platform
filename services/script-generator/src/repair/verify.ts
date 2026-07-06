/**
 * Verify gate (plan §New module #1). Runs ONE emitted spec against the live SUT
 * and reports whether it reproduces its mined `status_signature`.
 *
 * Why `test.status === "passed"` IS the oracle: every emitted step asserts its
 * own `expected_status` inline (`emit.ts` `expect(resp.status()).toBe(...)`), and
 * the setup handshake (register/create-customer/login) asserts 200 too. So a
 * green test means EVERY asserted status held — i.e. the spec reproduced the
 * behavior the behavior-engine mined. A red means some status drifted; the failed
 * step(s) carry expected-vs-actual + the captured response body for the agent.
 *
 * Reuses the test-runner rather than re-shelling Playwright: `runPlaywright`
 * scopes to one persona project + a path filter, and `collectFromFile` parses the
 * per-step results the same way the dashboard report does.
 */
import { existsSync, readFileSync } from "node:fs";
import { collectFromFile, type NormalizedTest } from "../../../test-runner/src/collect.js";
import { runPlaywright, type Project } from "../../../test-runner/src/run.js";

export interface StepOutcome {
  /** The step title as emitted, e.g. "POST /admin/orders/{id}/cancel". */
  endpoint: string;
  expected: number | null;
  actual: number | null;
  responseBody: string | null;
  failureMessage: string | null;
}

export interface VerifyResult {
  relPath: string;
  /** The `// status_signature:` header — the immutable expected sequence. */
  expectedSignature: string | null;
  /** True when the spec is gated out (`test.fixme`) — NEVER escalate these. */
  fixme: boolean;
  /** True when Playwright actually executed the spec and produced a report. */
  ran: boolean;
  status: "passed" | "failed" | "skipped";
  /** The repair oracle: did every asserted status hold? */
  matched: boolean;
  /** Failed steps, with the diff + response body the agent needs to reason. */
  failures: StepOutcome[];
  /** Tail of Playwright stdout/stderr — full failure context for the agent. */
  stdoutTail: string;
}

const STATUS_SIGNATURE_HEADER = /^\/\/ status_signature:\s*([\d,]+)/m;
const MAX_STDOUT_TAIL = 8 * 1024;

/** The persona project a spec belongs to is its top folder: `admin/...` -> "admin". */
function personaOf(relPath: string): Project {
  const top = relPath.split("/")[0];
  if (top === "guest" || top === "customer" || top === "admin") return top;
  throw new Error(`cannot derive persona project from spec path "${relPath}"`);
}

/** Match the collected test back to the spec we ran (collect keys `file` off the suite). */
function findTest(tests: NormalizedTest[], relPath: string): NormalizedTest | undefined {
  const hash = relPath.split("/").pop() ?? relPath;
  return tests.find((t) => t.file.endsWith(relPath) || t.file.endsWith(hash));
}

/**
 * Run a single spec and diff it against its mined outcome.
 * `relPath` is repo-relative to generated-tests/, e.g.
 * `admin/happy-path/9814b5a0bf73.spec.ts`.
 */
export async function verifySpec(
  relPath: string,
  absSpecPath: string
): Promise<VerifyResult> {
  const source = existsSync(absSpecPath) ? readFileSync(absSpecPath, "utf8") : "";
  const expectedSignature = STATUS_SIGNATURE_HEADER.exec(source)?.[1] ?? null;
  const fixme = source.includes("test.fixme(");

  const base: VerifyResult = {
    relPath,
    expectedSignature,
    fixme,
    ran: false,
    status: "skipped",
    matched: false,
    failures: [],
    stdoutTail: "",
  };

  // A fixme spec is intentionally gated out — not a verify failure, never escalate.
  if (fixme) return { ...base, status: "skipped" };

  // Repair verification happens before HITL approval by design. Execute this
  // exact quarantined draft through the runner's validated internal bypass;
  // normal suite runs remain approval-gated.
  const run = await runPlaywright({
    target: personaOf(relPath),
    directSpecPaths: [relPath],
  });
  const stdoutTail = `${run.stdout}\n${run.stderr}`.slice(-MAX_STDOUT_TAIL);

  if (!existsSync(run.jsonReportPath)) {
    return { ...base, ran: false, stdoutTail };
  }

  const result = collectFromFile(run.jsonReportPath);
  const test = findTest(result.tests, relPath);
  if (!test) {
    return { ...base, ran: true, stdoutTail };
  }

  const status = test.status === "passed" ? "passed" : test.status === "skipped" ? "skipped" : "failed";
  const failures: StepOutcome[] = test.steps
    .filter((s) => s.status === "failed" || s.status === "timedOut" || s.status === "interrupted")
    .map((s) => ({
      endpoint: s.endpoint,
      expected: s.expected_status,
      actual: s.actual_status,
      responseBody: s.response_body ?? null,
      failureMessage: s.failure_message,
    }));

  return {
    ...base,
    ran: true,
    status,
    matched: status === "passed",
    failures,
    stdoutTail,
  };
}
