/**
 * Evaluation harness orchestration.
 *
 * Runs the approved regression suite once on a clean SUT (baseline) and once per
 * seeded fault, arming each fault by recreating the Medusa process. From the
 * normalized results it derives: regression-detection rate (did the suite catch
 * each seeded fault?), script executability (baseline pass rate), and false
 * positives (baseline reds). Reuses the runner's own runPlaywright +
 * collectFromFile so "what the harness runs" is byte-identical to a real
 * `npm run test:<target>`.
 */
import { existsSync } from "node:fs";
import { collectFromFile, type NormalizedRunResult } from "../collect.js";
import { runPlaywright, type Target } from "../run.js";
import { armBackend } from "./backend.js";
import { FAULT_CATALOG, faultById, type EvalFault } from "./catalog.js";
import { classifyFault } from "./detect.js";
import {
  buildBaselineMetrics,
  summarizeDetection,
  type EvalMetrics,
  type FaultResult,
} from "./metrics.js";

export interface HarnessOptions {
  target: Target;
  /** Fault ids to seed; defaults to the whole catalog. */
  faultIds?: string[];
  runBaseline: boolean;
  /** Sink for progress lines (defaults to console.log). */
  log?: (line: string) => void;
}

function emptyResult(): NormalizedRunResult {
  return { generated_at: new Date().toISOString(), totals: { executed: 0, passed: 0, failed: 0, skipped: 0 }, tests: [] };
}

/** Arm (via restart) then run the suite, returning the normalized result. */
async function runWithFault(
  faultId: string | null,
  target: Target,
  log: (line: string) => void
): Promise<{ result: NormalizedRunResult; armError: string | null }> {
  const arm = await armBackend(faultId);
  log(`    ${arm.detail}`);
  if (!arm.ok) return { result: emptyResult(), armError: arm.detail };

  const run = await runPlaywright({ target });
  if (!existsSync(run.jsonReportPath)) {
    return { result: emptyResult(), armError: "Playwright produced no JSON report (run invalid)" };
  }
  return { result: collectFromFile(run.jsonReportPath), armError: null };
}

function selectFaults(faultIds: string[] | undefined): EvalFault[] {
  if (!faultIds || faultIds.length === 0) return FAULT_CATALOG;
  const selected: EvalFault[] = [];
  for (const id of faultIds) {
    const f = faultById(id);
    if (f) selected.push(f);
  }
  return selected;
}

export async function runEvaluation(options: HarnessOptions): Promise<EvalMetrics> {
  const log = options.log ?? ((l: string) => console.log(l));
  const faults = selectFaults(options.faultIds);

  let baseline: NormalizedRunResult | null = null;
  if (options.runBaseline) {
    log(`  Baseline run (no fault):`);
    const { result, armError } = await runWithFault(null, options.target, log);
    if (armError) log(`    ⚠ baseline unmeasurable: ${armError}`);
    baseline = result;
  }

  const faultResults: FaultResult[] = [];
  for (const fault of faults) {
    log(`  Fault "${fault.id}" (${fault.faultClass}):`);
    const { result, armError } = await runWithFault(fault.id, options.target, log);
    if (armError) {
      faultResults.push({
        id: fault.id,
        title: fault.title,
        faultClass: fault.faultClass,
        targetEndpoint: fault.targetEndpoint,
        expectedSignal: fault.expectedSignal,
        caught: false,
        catchingTest: null,
        evidence: null,
        unmeasurable: armError,
      });
      continue;
    }
    const verdict = classifyFault(fault, result, baseline);
    log(`    ${verdict.caught ? "✓ caught" : "✗ missed"}${verdict.baselinePreexistingFailure ? " (baseline already red on endpoint — not attributable)" : ""}`);
    faultResults.push({
      id: fault.id,
      title: fault.title,
      faultClass: fault.faultClass,
      targetEndpoint: fault.targetEndpoint,
      expectedSignal: fault.expectedSignal,
      caught: verdict.caught,
      catchingTest: verdict.catchingTest,
      evidence: verdict.evidence,
      unmeasurable: null,
    });
  }

  // Leave the SUT disarmed. Without this the backend stays recreated on the LAST
  // fault, silently poisoning any subsequent demo/suite run. armBackend no-ops
  // under EVAL_SKIP_RESTART, so this only recreates when the harness owns restarts
  // and actually touched the container.
  if (faults.length > 0) {
    log(`  Restoring clean SUT (disarm):`);
    const restore = await armBackend(null);
    log(`    ${restore.detail}`);
  }

  const baselineMetrics = baseline
    ? buildBaselineMetrics(baseline.totals, baseline.tests.filter((t) => t.status !== "passed" && t.status !== "skipped").map((t) => t.flow_name || t.title))
    : null;
  const detection = summarizeDetection(faultResults);

  return {
    generated_at: new Date().toISOString(),
    target: options.target,
    baseline: baselineMetrics,
    faults: faultResults,
    ...detection,
  };
}
