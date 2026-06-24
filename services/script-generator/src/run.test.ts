/**
 * Unit test for the approval-aware generator helpers (run.ts). Run:
 * `npm run test:run`. Plain assertions, no framework — mirrors the repo style.
 *
 * Covers the two safety guarantees of the regression/conflict handling:
 *   1. an approved spec is PRESERVED across the clean (the blessed oracle survives
 *      a regen and keeps running, so it goes red on drift), while non-approved
 *      specs are removed as before;
 *   2. the approved outcome is read from the HITL store so the loop can withhold a
 *      drifted candidate instead of codifying it.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedOutcomes, cleanPersonaFolderPreservingApproved } from "./run.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const SIG_APPROVED = "a".repeat(64);
const SIG_OTHER = "b".repeat(64);

const spec = (sig: string, outcome: string): string =>
  `// flow_signature: ${sig}\n// status_signature: ${outcome}\ntest("x", async () => {});\n`;

// 1. approvedOutcomes reads blessed outcomes (approved only) from the HITL store.
check("approvedOutcomes reads approved status_signatures from the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const store = join(dir, "approvals.json");
  writeFileSync(
    store,
    JSON.stringify({
      entries: [
        { flow_signature: SIG_APPROVED, status: "approved", status_signature: "200,200,200" },
        { flow_signature: SIG_OTHER, status: "discarded", status_signature: "200,401" },
      ],
    })
  );
  const map = approvedOutcomes(store);
  assert.deepEqual([...(map.get(SIG_APPROVED) ?? [])], ["200,200,200"]);
  assert.equal(map.has(SIG_OTHER), false, "discarded entries are not blessed baselines");
});

// 2. The clean PRESERVES a blessed oracle and removes a non-approved one.
check("clean preserves the blessed oracle, removes the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const personaDir = join(dir, "customer");
  mkdirSync(join(personaDir, "happy-path"), { recursive: true });
  mkdirSync(join(personaDir, "failure-path"), { recursive: true });
  const oracle = join(personaDir, "happy-path", "aaaaaaaaaaaa.spec.ts");
  const stale = join(personaDir, "failure-path", "bbbbbbbbbbbb.spec.ts");
  writeFileSync(oracle, spec(SIG_APPROVED, "200,200,200"));
  writeFileSync(stale, spec(SIG_OTHER, "200,401"));

  const approved = new Map([[SIG_APPROVED, new Set(["200,200,200"])]]);
  const preserved = cleanPersonaFolderPreservingApproved(personaDir, approved);

  assert.equal(preserved, 1);
  assert.equal(existsSync(oracle), true, "blessed oracle survives the regen");
  assert.equal(existsSync(stale), false, "non-approved spec is cleaned");
});

// 3. RETIREMENT: once a DIFFERENT outcome is approved for the same journey, the
//    old-outcome spec is stale and must be dropped so the new oracle can regenerate.
check("clean retires a stale oracle whose blessed outcome changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const personaDir = join(dir, "customer");
  mkdirSync(join(personaDir, "happy-path"), { recursive: true });
  const staleOracle = join(personaDir, "happy-path", "aaaaaaaaaaaa.spec.ts");
  writeFileSync(staleOracle, spec(SIG_APPROVED, "200,200,200")); // old blessed 200

  // Operator has since approved the drift: the blessed outcome is now 200,200,500.
  const approved = new Map([[SIG_APPROVED, new Set(["200,200,500"])]]);
  const preserved = cleanPersonaFolderPreservingApproved(personaDir, approved);

  assert.equal(preserved, 0, "stale oracle is not preserved");
  assert.equal(existsSync(staleOracle), false, "old-outcome spec is retired");
});

console.log(`\nrun.test: ${passed} checks passed`);
