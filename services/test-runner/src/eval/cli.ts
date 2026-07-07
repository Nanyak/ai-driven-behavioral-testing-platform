#!/usr/bin/env node
/**
 * Regression-evaluation CLI.
 *
 *   npm run eval                     # baseline + all catalog faults, target=customer
 *   npm run eval -- --target drafts  # run draft (unapproved) specs instead
 *   npm run eval -- --faults order_total_mismatch,order_status_completed
 *   npm run eval -- --no-baseline
 *   EVAL_SKIP_RESTART=1 npm run eval # toggle the SUT by hand, harness only runs/measures
 *
 * MUST run on the HOST: it recreates the Medusa container between faults (unless
 * EVAL_SKIP_RESTART=1). Writes reports/eval/metrics.{json,html}.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { storage } from "../../../../packages/storage/index.js";
import { PATH_FILTERS, PROJECTS, REPO_REPORTS_DIR, type Target } from "../run.js";
import { FAULT_CATALOG } from "./catalog.js";
import { runEvaluation } from "./harness.js";
import { renderConsole, renderHtml } from "./metrics.js";

const VALID_TARGETS: Target[] = ["all", ...PROJECTS, ...PATH_FILTERS, "drafts"];

interface CliArgs {
  target: Target;
  faultIds: string[] | undefined;
  runBaseline: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let target: Target = "customer";
  let faultIds: string[] | undefined;
  let runBaseline = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      const t = (argv[++i] ?? "").toLowerCase();
      if (!(VALID_TARGETS as string[]).includes(t)) {
        console.error(`Unknown --target "${t}". Use one of: ${VALID_TARGETS.join(", ")}`);
        process.exit(2);
      }
      target = t as Target;
    } else if (arg === "--faults") {
      faultIds = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--no-baseline") {
      runBaseline = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Faults: ${FAULT_CATALOG.map((f) => f.id).join(", ")}\nTargets: ${VALID_TARGETS.join(", ")}`);
      process.exit(0);
    } else {
      console.error(`Unknown argument "${arg}"`);
      process.exit(2);
    }
  }
  return { target, faultIds, runBaseline };
}

async function main(): Promise<void> {
  const { target, faultIds, runBaseline } = parseArgs(process.argv.slice(2));
  console.log(`Regression evaluation — target=${target}, faults=${faultIds?.join(",") ?? "all"}, baseline=${runBaseline}`);

  const metrics = await runEvaluation({ target, faultIds, runBaseline });

  const outDir = resolvePath(REPO_REPORTS_DIR, "eval");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolvePath(outDir, "metrics.json");
  const htmlPath = resolvePath(outDir, "metrics.html");
  const json = JSON.stringify(metrics, null, 2);
  const html = renderHtml(metrics);
  writeFileSync(jsonPath, json);
  writeFileSync(htmlPath, html);

  // Also publish to the blob store the dashboard reads (it serves reports from
  // storage, not disk), so the Evaluation view surfaces the latest metrics.
  // Best-effort: a storage-less/local run still succeeds on the on-disk files.
  try {
    await storage.blobs.put("reports/eval/metrics.json", Buffer.from(json, "utf8"));
    await storage.blobs.put("reports/eval/metrics.html", Buffer.from(html, "utf8"));
  } catch (error) {
    console.warn(`  (metrics not published to blob store: ${error instanceof Error ? error.message : error})`);
  }

  console.log(renderConsole(metrics));
  console.log(`\n  Metrics (JSON): ${jsonPath}`);
  console.log(`  Metrics (HTML): ${htmlPath}`);

  // Non-zero exit only when a run was genuinely broken (baseline not green, or a
  // fault could not be measured) — a MISSED fault is a real finding, not a
  // harness error, so it does not fail the process.
  const baselineBroken = metrics.baseline !== null && !metrics.baseline.clean;
  const anyUnmeasurable = metrics.faults.some((f) => f.unmeasurable !== null);
  process.exit(baselineBroken || anyUnmeasurable ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
