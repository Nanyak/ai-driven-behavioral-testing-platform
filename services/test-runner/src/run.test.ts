import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "./report/build.js";
import { renderHtml } from "./report/html.js";
import { formatReportSummary } from "./report/summary.js";
import {
  buildArgs,
  clearPreviousRunArtifacts,
  effectiveBodyPlanHash,
  exactApprovalMatches,
  validateDirectSpecPaths,
} from "./run.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("zero-test result is INVALID, never GREEN", () => {
  const report = buildReport({
    generated_at: "2026-06-27T00:00:00.000Z",
    totals: { executed: 0, passed: 0, failed: 0, skipped: 0 },
    tests: [],
  });
  assert.equal(report.status, "invalid");
  assert.match(formatReportSummary(report), /INVALID/);
  assert.match(renderHtml(report), /No runnable tests completed/);
  assert.doesNotMatch(renderHtml(report), /All 0 tests passed/);
});

check("all-skipped result is INVALID because it has no runnable evidence", () => {
  const report = buildReport({
    generated_at: "2026-06-27T00:00:00.000Z",
    totals: { executed: 1, passed: 0, failed: 0, skipped: 1 },
    tests: [
      {
        persona: "guest_shopper",
        flow_name: "Unresolved flow",
        flow_signature: null,
        source_sessions: [],
        project: "guest",
        file: "guest/failure-path/x.spec.ts",
        title: "unresolved",
        status: "skipped",
        duration_ms: 0,
        steps: [],
      },
    ],
  });
  assert.equal(report.status, "invalid");
});

check("previous JSON and HTML reporter artifacts are removed before a run", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-artifacts-"));
  const json = join(dir, "results.json");
  const html = join(dir, "html");
  mkdirSync(html);
  writeFileSync(json, '{"stale":true}');
  writeFileSync(join(html, "index.html"), "stale");

  clearPreviousRunArtifacts(json, html);

  assert.equal(existsSync(json), false);
  assert.equal(existsSync(html), false);
  rmSync(dir, { recursive: true, force: true });
});

check("approval binds both exact spec and body-plan hashes", () => {
  const decision = {
    flow_signature: "a".repeat(64),
    status: "approved",
    spec_hash: "spec-a",
    body_plan_hash: "plan-a",
  };
  assert.equal(exactApprovalMatches("spec-a", "plan-a", decision), true);
  assert.equal(exactApprovalMatches("spec-b", "plan-a", decision), false);
  assert.equal(exactApprovalMatches("spec-a", "plan-b", decision), false);
  assert.equal(exactApprovalMatches("spec-a", "plan-a", { ...decision, status: "discarded" }), false);
});

check("agent-repaired body plan is bound to the repaired source hash", () => {
  const manifest = { body_plan_hash: "baseline", body_plan: { version: 1, steps: [] } };
  const repaired = effectiveBodyPlanHash("// repaired-by: resolver-agent", "source-a", manifest);
  const changed = effectiveBodyPlanHash("// repaired-by: resolver-agent", "source-b", manifest);
  assert.notEqual(repaired, "baseline");
  assert.notEqual(repaired, changed);
  assert.equal(effectiveBodyPlanHash("// generated", "source-a", manifest), "baseline");
});

check("exact allowlist paths are passed to Playwright with persona scoping", () => {
  assert.deepEqual(
    buildArgs("customer", [], ["customer/happy-path/a.spec.ts"]),
    ["playwright", "test", "customer/happy-path/a.spec.ts", "--project", "customer"]
  );
});

check("repair direct-spec bypass accepts only an exact same-persona generated spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-direct-spec-"));
  const adminDir = join(dir, "admin", "happy-path");
  const customerDir = join(dir, "customer", "happy-path");
  mkdirSync(adminDir, { recursive: true });
  mkdirSync(customerDir, { recursive: true });
  writeFileSync(join(adminDir, "a.spec.ts"), "// admin");
  writeFileSync(join(customerDir, "b.spec.ts"), "// customer");

  assert.deepEqual(
    validateDirectSpecPaths("admin", ["admin/happy-path/a.spec.ts"], dir),
    { ok: true, paths: ["admin/happy-path/a.spec.ts"] }
  );
  assert.equal(
    validateDirectSpecPaths("admin", ["customer/happy-path/b.spec.ts"], dir).ok,
    false
  );
  assert.equal(
    validateDirectSpecPaths("admin", ["../admin/happy-path/a.spec.ts"], dir).ok,
    false
  );
  assert.equal(validateDirectSpecPaths("all", ["admin/happy-path/a.spec.ts"], dir).ok, false);

  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nrun.test: ${passed} checks passed`);
