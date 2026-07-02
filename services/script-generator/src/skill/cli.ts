#!/usr/bin/env node
/**
 * Skill verification CLI — the "verify" side of the skill library's
 * anti-hallucination contract (mirrors src/invariants/cli.ts).
 *
 *   tsx src/skill/cli.ts                       # (re)propose: rebuild the artifact
 *                                              # from the registry, all verified:false
 *   tsx src/skill/cli.ts --verify reports/playwright/normalized.json
 *                                              # bake: flip a skill to verified:true
 *                                              # ONLY if its oracle held on that
 *                                              # known-good run's captured bodies
 *
 * A skill is a keyed (entity,state) recipe whose oracle asserts it produced the
 * state (see registry.ts). Like invariants, a skill is trusted ONLY when its
 * oracle was checked once against the live known-good backend and HELD. This CLI
 * replays each oracle against the response bodies captured by a known-good
 * Playwright run (test-runner collect output, normalized.json) — the same source
 * the invariants CLI verifies against. No live HTTP happens here: the backend
 * work already happened when the known-good run executed; we replay its bodies.
 * (Replay, not re-request — the same anti-hallucination bake gate as invariants.)
 *
 * `npm run generate` reads `data/skills/skills.json` and warns (stderr, never
 * alters specs) when it uses a skill still marked unverified — so a resolver
 * whose seed assumption silently rotted (empty /admin/returns, etc.) surfaces
 * here instead of as a flaky 4xx three layers downstream.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import {
  SKILLS,
  buildSkillsArtifact,
  saveSkills,
  skillId,
  verifySkills,
  type SkillsArtifact,
} from "./registry.js";

/**
 * Flatten every step of a known-good normalized run into `endpoint -> body`.
 * Skills' resolve steps (e.g. `GET /store/regions`) run as setup inside the
 * generated specs, so their request endpoints appear as steps here. The newest
 * captured body for an endpoint wins (last write) — any known-good body proves
 * the oracle equally well.
 */
function endpointBodiesFromRun(normalizedPath: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const report = JSON.parse(readFileSync(normalizedPath, "utf8")) as {
    tests?: Array<{ steps?: Array<{ endpoint: string; response_body?: string | null }> }>;
  };
  for (const test of report.tests ?? []) {
    for (const step of test.steps ?? []) {
      if (!step.response_body) continue;
      try {
        out.set(step.endpoint, JSON.parse(step.response_body));
      } catch {
        // non-JSON body excerpt — skip; the skill stays unverified
      }
    }
  }
  return out;
}

/**
 * Resolve captured bodies onto each skill's oracle endpoint. A skill oracle's
 * `endpoint` is the exact resolve-step endpoint it reads (query string and all).
 * We match exactly first, then fall back to the query-stripped path so a resolver
 * whose captured URL carried resolved query values still matches the templated
 * oracle endpoint. Returns a map keyed by `oracle.endpoint` for `verifySkills`.
 */
export function bodiesByOracleEndpoint(runBodies: Map<string, unknown>): Map<string, unknown> {
  const pathOf = (e: string): string => e.split("?")[0];
  const byPath = new Map<string, unknown>();
  for (const [endpoint, body] of runBodies) byPath.set(pathOf(endpoint), body);

  const out = new Map<string, unknown>();
  for (const skill of SKILLS) {
    const target = skill.oracle.endpoint;
    if (runBodies.has(target)) out.set(target, runBodies.get(target));
    else if (byPath.has(pathOf(target))) out.set(target, byPath.get(pathOf(target)));
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyIdx = args.indexOf("--verify");
  const verifyPath = verifyIdx >= 0 ? args[verifyIdx + 1] : undefined;

  let artifact: SkillsArtifact;
  if (verifyPath) {
    const runBodies = endpointBodiesFromRun(verifyPath);
    const bodies = bodiesByOracleEndpoint(runBodies);
    artifact = verifySkills(bodies);
    const verified = Object.values(artifact.skills).filter((s) => s.verified).length;
    const total = Object.keys(artifact.skills).length;
    saveSkills(artifact);
    console.log(`Skill verification complete (source: ${verifyPath}).`);
    console.log(`  Skills registered:  ${total}`);
    console.log(`  Oracles matched:    ${bodies.size}`);
    console.log(`  Verified (held):    ${verified}`);
    const missing = SKILLS.filter((s) => !bodies.has(s.oracle.endpoint)).map((s) =>
      skillId(s.key, s.auth)
    );
    if (missing.length) {
      console.log(
        `  Unmatched (no captured body — stay unverified): ${missing.length}\n    ${missing.join("\n    ")}`
      );
    }
  } else {
    artifact = buildSkillsArtifact();
    saveSkills(artifact);
    console.log(
      `Skills artifact rebuilt from registry: ${Object.keys(artifact.skills).length} skills, all verified:false.`
    );
    console.log("Run with --verify <normalized.json> to bake against a known-good run.");
  }
}

// Entry-point guard: only run when invoked directly (not when a test imports
// `bodiesByOracleEndpoint`), so importing this module never overwrites skills.json.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
