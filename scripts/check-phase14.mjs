#!/usr/bin/env node

/**
 * Phase 14 verification: Final Validation (offline sign-off).
 *
 * Phase 14 is the dress rehearsal for the demo: a clean-state run of the entire
 * pipeline (Medusa + ELK up, traffic -> Kibana -> green report -> injected
 * regression -> revert). That live run is documented as a runbook in
 * docs/phase-14-implementation-plan.md and docs/pipeline.md and requires the full
 * Docker stack.
 *
 * This check is the OFFLINE half of the sign-off gate: it proves that every
 * stage's logic is green against committed fixtures by chaining each phase's own
 * fixture-backed check in order, and that the Phase 13 documentation deliverables
 * exist. It does NOT stand in for the live clean run; it is the reproducible,
 * stack-free portion that can gate every commit.
 *
 * Phases 1, 4, and 5 are deliberately EXCLUDED here: those checks probe the live
 * stack (Medusa/Postgres/Redis, Elasticsearch/Kibana, indexed traffic) and only
 * pass when the stack is up. They are verified during the live clean run
 * (docs/pipeline.md), not in this stack-free aggregate.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function ok(msg) {
  passed += 1;
  console.log(`  ok  ${msg}`);
}

function fail(name, detail) {
  failed += 1;
  console.log(`  XX  ${name}${detail ? ` -> ${detail}` : ""}`);
}

// [1] Offline pipeline sign-off: the fixture-backed phase checks, in order.
// (1/4/5 excluded — they probe the live stack; see the live clean run.)
console.log("[1] Offline pipeline sign-off (fixture-backed phases + Phase 15 HITL)");

const phases = [0, 2, 3, 6, 7, 8, 9, 10, 11, 12, 15];
for (const p of phases) {
  const r = spawnSync("npm", ["run", `check:phase${p}`, "--silent"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (r.status === 0) {
    ok(`check:phase${p}`);
  } else {
    const tail = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-3).join(" | ");
    fail(`check:phase${p}`, tail);
  }
}

// [2] Traffic generator hard gate: TypeScript must compile clean (CLAUDE.md §3).
console.log("\n[2] Traffic generator tsc --noEmit (hard gate)");
const tsc = spawnSync("npx", ["tsc", "--noEmit"], {
  cwd: resolve(ROOT, "services", "traffic-generator"),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
if (tsc.status === 0) ok("services/traffic-generator compiles clean");
else fail("traffic-generator tsc", `${tsc.stdout || ""}${tsc.stderr || ""}`.trim().split("\n").slice(-3).join(" | "));

// [3] Phase 13 documentation deliverables exist.
console.log("\n[3] Phase 13 documentation deliverables");
const docs = [
  "README.md",
  "docs/architecture.md",
  "docs/pipeline.md",
  "docs/limitations.md"
];
for (const d of docs) {
  if (existsSync(resolve(ROOT, d))) ok(d);
  else fail("missing doc", d);
}

// Summary.
const total = passed + failed;
console.log(`\n${total} checks - ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nOne or more offline checks failed. Re-run the failing phase directly,");
  console.log("e.g. `npm run check:phase7`, for full output.");
  process.exit(1);
}
console.log("\nAll Phase 14 offline checks passed.");
console.log("Live-stack phases (1/4/5) + clean-run dress rehearsal: docs/pipeline.md + docs/phase-14-implementation-plan.md");
