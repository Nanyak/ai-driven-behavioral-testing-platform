#!/usr/bin/env node

/**
 * Phase 7 verification: Behavioral Modeling Engine
 *
 * Validates the latest behavior-engine artifacts (service-local
 * data/candidates/ + data/validation/) against the plan's acceptance bullets
 * and the audit-resolved gates:
 *   - >= 5 test candidates produced,
 *   - emergent persona only (persona_source: "emergent_attributes"),
 *   - per-persona cap of 10, and >= 1 candidate per non-error persona,
 *   - holdout recovered with support >= 6 (Phase 5 holdout floor),
 *   - cart signal net-positive (registered_customer recall up, macro-F1 not down),
 *   - negative control passes,
 *   - contamination -> highest privilege (no misclassified session WITH a content
 *     privilege-signal),
 *   - >= 1 edge (has_errors) candidate,
 *   - skipped_existing present in the run summary,
 *   - validation report emits BOTH rule variants (endpoint-only + cart-signal).
 *
 * Also runs the signature golden/unit test and a clean tsc --noEmit (hard gate).
 * Reads produced output, so it needs no running stack. Mine first:
 *   npm run behavior:mine
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICE = resolve(ROOT, "services", "behavior-engine");
const CANDIDATES_DIR = resolve(SERVICE, "data", "candidates");
const VALIDATION_DIR = resolve(SERVICE, "data", "validation");

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

function latest(dir, prefix) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();
  return files.length ? resolve(dir, files[files.length - 1]) : null;
}

const PERSONAS = ["guest_shopper", "registered_customer", "admin_operator"];

function main() {
  console.log("Phase 7: Behavioral Modeling Engine Check");

  // [0] signature golden test (the single-source flow signature, ADR 0002).
  console.log("\n[0] signature.ts golden/unit test");
  const sig = spawnSync("npx", ["tsx", "src/signature.test.ts"], {
    cwd: SERVICE,
    encoding: "utf8",
  });
  if (sig.status === 0) ok("signature golden test passes");
  else fail("signature golden test", (sig.stderr || sig.stdout || "").trim().split("\n").pop());

  // [1] TypeScript compiles clean (hard gate).
  console.log("\n[1] TypeScript compile (tsc --noEmit)");
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: SERVICE, encoding: "utf8" });
  if (tsc.status === 0) ok("tsc --noEmit is clean");
  else fail("tsc --noEmit", (tsc.stdout || tsc.stderr || "").trim().split("\n").slice(0, 3).join(" | "));

  // [2] Candidate artifact.
  console.log("\n[2] Test candidates");
  const candFile = latest(CANDIDATES_DIR, "test-candidates-");
  if (!candFile) {
    fail("candidate artifact present", "run `npm run behavior:mine` first");
    return summary();
  }
  console.log(`  artifact: ${candFile}`);
  const cand = JSON.parse(readFileSync(candFile, "utf8"));

  if (cand.candidate_count >= 5) ok(`${cand.candidate_count} candidates (>=5)`);
  else fail(">=5 candidates", `found ${cand.candidate_count}`);

  const allEmergent = cand.candidates.every((c) => c.persona_source === "emergent_attributes");
  if (allEmergent) ok("every candidate persona_source = emergent_attributes");
  else fail("emergent persona only", "a candidate is not emergent");

  const perPersona = cand.per_persona_counts ?? {};
  const capOk = PERSONAS.every((p) => (perPersona[p] ?? 0) <= 10);
  if (capOk) ok(`per-persona cap of 10 respected (${JSON.stringify(perPersona)})`);
  else fail("per-persona cap of 10", JSON.stringify(perPersona));

  const eachPersona = PERSONAS.every((p) => (perPersona[p] ?? 0) >= 1);
  if (eachPersona) ok(">=1 candidate per non-error persona");
  else fail(">=1 candidate per non-error persona", JSON.stringify(perPersona));

  const edge = cand.candidates.filter((c) => c.attributes && c.attributes.has_errors);
  if (edge.length >= 1) ok(`>=1 edge (has_errors) candidate (support ${edge.map((c) => c.support).join(",")})`);
  else fail(">=1 edge candidate", "no has_errors candidate survived mining");

  if (typeof cand.skipped_existing === "number") ok(`skipped_existing reported (${cand.skipped_existing})`);
  else fail("skipped_existing reported", "missing from run summary");

  const adv = cand.candidates.every(
    (c) => c.assertion_hints && (c.assertion_hints.source === "advisory_llm" || c.assertion_hints.source === "advisory_fallback")
  );
  if (adv) ok("assertion hints present and marked advisory (ADR 0001 keeps OAS as oracle)");
  else fail("advisory assertion hints", "a candidate has non-advisory hints");

  // [3] Validation report.
  console.log("\n[3] Classification report");
  const valFile = latest(VALIDATION_DIR, "classification-report-");
  if (!valFile) {
    fail("validation artifact present", "run `npm run behavior:mine` first");
    return summary();
  }
  console.log(`  artifact: ${valFile}`);
  const val = JSON.parse(readFileSync(valFile, "utf8"));

  const cls = val.classification;
  if (cls && cls.endpoint_only && cls.cart_signal && cls.cart_read_signal)
    ok("all three rule variants emitted (endpoint-only + cart-signal + cart_read_signal, ADR 0006)");
  else fail("three rule variants", "report missing a variant");

  if (val.ground_truth_footnote && val.ground_truth_footnote.length > 0) ok("ground-truth footnote present (PO-2)");
  else fail("ground-truth footnote", "missing");

  if (val.holdout && val.holdout.passes && val.holdout.support >= val.holdout.floor)
    ok(`holdout recovered: support ${val.holdout.support} (floor ${val.holdout.floor})`);
  else fail("holdout support >= floor", `support ${val.holdout?.support}, floor ${val.holdout?.floor}`);

  const recallUp = cls.registered_customer_recall_lift >= 0;
  const f1NotDown = cls.macro_f1_delta >= 0;
  if (recallUp && f1NotDown)
    ok(`cart signal net-positive (recall +${cls.registered_customer_recall_lift.toFixed(4)}, macro-F1 delta ${cls.macro_f1_delta.toFixed(4)})`);
  else fail("cart signal net-positive", `recall lift ${cls.registered_customer_recall_lift}, F1 delta ${cls.macro_f1_delta}`);

  const rs = cls.read_signal;
  if (rs && rs.registered_customer_recall_lift >= 0 && rs.macro_f1_delta >= 0)
    ok(`read signal net-positive (recall +${rs.registered_customer_recall_lift.toFixed(4)}, macro-F1 delta ${rs.macro_f1_delta.toFixed(4)}) (ADR 0006)`);
  else fail("read signal net-positive", `recall lift ${rs?.registered_customer_recall_lift}, F1 delta ${rs?.macro_f1_delta}`);

  if (val.negative_control && val.negative_control.passes)
    ok(`negative control passes (successful store-returns ${val.negative_control.successfulStoreReturnSessions}, chimera support ${val.negative_control.chimeraSupport})`);
  else fail("negative control passes", JSON.stringify(val.negative_control));

  if (val.contamination && val.contamination.passes)
    ok(`contamination -> highest privilege (0 misclassified WITH signal; ${val.contamination.groundTruthGaps} ground-truth gaps)`);
  else fail("contamination -> highest privilege", JSON.stringify(val.contamination));

  summary();
}

function summary() {
  console.log(`\n${passed + failed} checks - ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Mine candidates:  npm run behavior:mine");
    console.log("     (needs an ingested artifact in data/sessions/ — run `npm run ingest:run` first)");
    console.log("  2. Then re-run:      npm run check:phase7");
    process.exit(1);
  }
  console.log("\nAll Phase 7 checks passed.");
}

main();
