#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { storage } from "../../../packages/storage/index.js";
import { PATH_FILTERS, PROJECTS, REPO_REPORTS_DIR, type Target } from "../../test-runner/src/run.js";
import { readGoldenResponses } from "./golden-source.js";
import { runMutationEvaluation } from "./harness/run.js";
import { renderConsole, renderHtml } from "./metrics.js";
import { generateMutants } from "./mutants/generate.js";

const VALID_TARGETS: Target[] = ["all", ...PROJECTS, ...PATH_FILTERS, "drafts"];

interface CliArgs {
  target: Target;
  only: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let target: Target = "customer";
  let only: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      const value = (argv[++i] ?? "").toLowerCase();
      if (!(VALID_TARGETS as string[]).includes(value)) {
        throw new Error(`Unknown --target "${value}". Use one of: ${VALID_TARGETS.join(", ")}`);
      }
      target = value as Target;
    } else if (arg === "--only") {
      only = argv[++i] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run eval:mutate -- [--target customer] [--only mutant-id]\nTargets: ${VALID_TARGETS.join(", ")}`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  return { target, only };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const goldens = await readGoldenResponses();
  let mutants = generateMutants(goldens);
  if (args.only) mutants = mutants.filter((mutant) => mutant.id === args.only);
  if (mutants.length === 0) {
    throw new Error(args.only ? `No generated mutant matched ${args.only}` : "No mutants generated from goldens");
  }

  console.log(`Mutation evaluation — target=${args.target}, mutants=${mutants.length}, goldens=${goldens.length}`);
  const metrics = await runMutationEvaluation({ target: args.target, mutants });

  const outDir = resolvePath(REPO_REPORTS_DIR, "eval");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolvePath(outDir, "mutation-metrics.json");
  const htmlPath = resolvePath(outDir, "mutation-metrics.html");
  const json = JSON.stringify(metrics, null, 2);
  const html = renderHtml(metrics);
  writeFileSync(jsonPath, `${json}\n`);
  writeFileSync(htmlPath, html);

  try {
    await storage.blobs.put("reports/eval/mutation-metrics.json", Buffer.from(json, "utf8"));
    await storage.blobs.put("reports/eval/mutation-metrics.html", Buffer.from(html, "utf8"));
  } catch (error) {
    console.warn(`  (mutation metrics not published to blob store: ${error instanceof Error ? error.message : error})`);
  }

  console.log(renderConsole(metrics));
  console.log(`\n  Metrics (JSON): ${jsonPath}`);
  console.log(`  Metrics (HTML): ${htmlPath}`);

  process.exit(metrics.baseline_clean ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
