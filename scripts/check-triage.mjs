#!/usr/bin/env node

/**
 * Triage agent verification (offline, deterministic).
 *
 * Proves, without a live stack or an ANTHROPIC_API_KEY, the things the
 * regression-triage agent depends on:
 *   [1] tsc --noEmit clean in services/test-runner (hard gate; also guards the
 *       golden barrels the runner imports).
 *   [2] The offline heuristic classifies the committed regressed-red fixture's
 *       500 as real_regression/high, and a green run yields zero verdicts.
 *   [3] writeTriage emits a valid sidecar triage.json and re-renders report.html
 *       with a verdict chip joined to the failure by its deterministic id.
 *   [4] Gate-safety: the default renderHtml(report) (no triage) has no triage
 *       column, and the report object carries no triage/verdict/body keys —
 *       report.json stays byte-stable for Phase 12.
 *   [5] v2b: the OAS required-paths resolver loads and degrades gracefully.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICE = resolve(ROOT, "services", "test-runner");
const RED = resolve(SERVICE, "fixtures", "regressed-red.normalized.json");
const GREEN = resolve(SERVICE, "fixtures", "baseline-green.normalized.json");

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

function main() {
  console.log("Triage Agent Check");

  if (!existsSync(resolve(SERVICE, "node_modules"))) {
    const install = spawnSync("npm", ["install"], { cwd: SERVICE, encoding: "utf8" });
    if (install.status !== 0) {
      fail("services/test-runner npm install");
      return summary();
    }
  }

  // [1] tsc clean (also fails if the golden flat barrels are missing).
  console.log("\n[1] TypeScript compile (services/test-runner tsc --noEmit)");
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: SERVICE, encoding: "utf8" });
  if (tsc.status === 0) ok("tsc --noEmit is clean");
  else fail("tsc --noEmit", (tsc.stdout || tsc.stderr || "").trim().split("\n").slice(0, 6).join(" | "));

  // [2]-[5] Behaviour, via a tsx probe over the committed fixtures.
  console.log("\n[2] Heuristic classification + [3] sidecar/HTML + [4] gate-safety + [5] required-paths");
  const outDir = mkdtempSync(resolve(tmpdir(), "triage-"));
  const probe = `
    import { readFileSync } from "node:fs";
    import { resolve } from "node:path";
    import { buildReport } from ${JSON.stringify(resolve(SERVICE, "src", "report", "build.js"))};
    import { renderHtml } from ${JSON.stringify(resolve(SERVICE, "src", "report", "html.js"))};
    import { buildEvidence } from ${JSON.stringify(resolve(SERVICE, "src", "triage", "evidence.js"))};
    import { heuristicVerdict } from ${JSON.stringify(resolve(SERVICE, "src", "triage", "heuristic.js"))};
    import { writeTriage } from ${JSON.stringify(resolve(SERVICE, "src", "triage", "triage.js"))};

    let specs = null;
    try {
      const mod = await import(${JSON.stringify(resolve(ROOT, "services", "golden", "src", "oas-source.js"))});
      specs = mod.loadAugmentedSpecs();
    } catch { specs = null; }

    let requiredOk = true;
    if (specs) {
      try {
        const rp = await import(${JSON.stringify(resolve(ROOT, "services", "golden", "src", "oas", "required-paths.js"))});
        const known = rp.requiredResponsePaths(specs, "GET", "/store/products", 200);
        const bogus = rp.requiredResponsePaths(specs, "GET", "/nope/nope", 200);
        requiredOk = (known === null || known instanceof Set) && bogus === null;
      } catch (e) { requiredOk = false; }
    }

    const redNorm = JSON.parse(readFileSync(${JSON.stringify(RED)}, "utf8"));
    const greenNorm = JSON.parse(readFileSync(${JSON.stringify(GREEN)}, "utf8"));

    const red = buildReport(redNorm, { runId: "run-red" });
    const green = buildReport(greenNorm, { runId: "run-green" });

    const evidence = buildEvidence(red, redNorm, specs);
    const verdicts = evidence.map((e) => ({
      failure_id: e.failure_id,
      ...heuristicVerdict(e),
      evidence: { endpoint: e.endpoint, expected_status: e.expected_status, actual_status: e.actual_status, diff_paths: [], required_missing: e.required_missing },
    }));
    const triage = { run_id: red.run_id, generated_at: "2026-06-23T00:00:00.000Z", model: "offline-heuristic", verdicts };

    const greenEvidence = buildEvidence(green, greenNorm, specs);

    const { triageJsonPath, htmlPath } = writeTriage(red, triage, ${JSON.stringify(outDir)});
    const triageJson = JSON.parse(readFileSync(triageJsonPath, "utf8"));
    const html = readFileSync(htmlPath, "utf8");
    const defaultHtml = renderHtml(red); // no triage arg

    process.stdout.write(JSON.stringify({
      redVerdictCount: verdicts.length,
      redVerdict: verdicts[0]?.verdict ?? null,
      redConfidence: verdicts[0]?.confidence ?? null,
      greenEvidenceCount: greenEvidence.length,
      htmlHasChip: html.includes('class="chip real_regression"'),
      htmlHasTriageHeader: html.includes("<th>Triage</th>"),
      defaultHtmlHasTriageHeader: defaultHtml.includes("<th>Triage</th>"),
      triageJsonValid: triageJson && Array.isArray(triageJson.verdicts) && triageJson.run_id === "run-red",
      reportJsonHasTriageKeys: /"verdict"|"triage"|"response_body"/.test(JSON.stringify(red)),
      requiredOk,
    }));
  `;
  const probePath = resolve(SERVICE, ".triage-probe.mts");
  writeFileSync(probePath, probe);
  const run = spawnSync("npx", ["tsx", probePath], { cwd: SERVICE, encoding: "utf8" });
  rmSync(probePath, { force: true });

  if (run.status !== 0) {
    fail("triage probe", (run.stdout || run.stderr || "").trim().split("\n").slice(-4).join(" | "));
    rmSync(outDir, { recursive: true, force: true });
    return summary();
  }

  let out;
  try {
    out = JSON.parse(run.stdout);
  } catch {
    fail("triage probe output parse", run.stdout.slice(0, 200));
    rmSync(outDir, { recursive: true, force: true });
    return summary();
  }

  if (out.redVerdictCount === 1 && out.redVerdict === "real_regression" && out.redConfidence === "high") {
    ok("regressed-red 500 classified real_regression/high (offline heuristic)");
  } else {
    fail("red classification", JSON.stringify({ n: out.redVerdictCount, v: out.redVerdict, c: out.redConfidence }));
  }

  if (out.greenEvidenceCount === 0) ok("green run yields zero failures to triage");
  else fail("green evidence", String(out.greenEvidenceCount));

  if (out.triageJsonValid) ok("writeTriage emits a valid sidecar triage.json");
  else fail("triage.json", "invalid shape");

  if (out.htmlHasChip && out.htmlHasTriageHeader) {
    ok("report.html re-rendered with the verdict chip (failure_id join works)");
  } else {
    fail("html chip", JSON.stringify({ chip: out.htmlHasChip, header: out.htmlHasTriageHeader }));
  }

  if (!out.defaultHtmlHasTriageHeader && !out.reportJsonHasTriageKeys) {
    ok("gate-safe: default report.html has no triage column; report object has no triage/body keys");
  } else {
    fail("gate-safety", JSON.stringify({ defaultHeader: out.defaultHtmlHasTriageHeader, reportKeys: out.reportJsonHasTriageKeys }));
  }

  if (out.requiredOk) ok("v2b required-paths resolver loads and degrades gracefully");
  else fail("required-paths", "resolver threw or returned an unexpected shape");

  rmSync(outDir, { recursive: true, force: true });
  summary();
}

function summary() {
  const total = passed + failed;
  console.log(`\n${total} checks - ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Install deps:  npm run test-runner:install");
    console.log("  2. Re-run:        npm run check:triage");
    process.exit(1);
  }
  console.log("\nAll triage checks passed.");
}

main();
