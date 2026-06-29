#!/usr/bin/env node
/**
 * Behavior-digest regenerator — the agent step that builds cache #1.
 *
 *   tsx src/invariants/digest-cli.ts           # regenerate only STALE digests
 *   tsx src/invariants/digest-cli.ts --force   # regenerate every mapped endpoint
 *
 * Stale = no digest file yet, or the workflow's content hash changed (Medusa was
 * upgraded). This is the right trigger to wire into `postinstall` / a CI step
 * gated on the lockfile — NOT a daily cron: core-flows is immutable between
 * dependency bumps, so a clock-based regen wastes agent calls and makes the
 * downstream invariant proposals non-reproducible.
 */
import { makeClaudeAgent } from "../repair/agent.js";
import {
  mappedEndpoints,
  readSource,
  workflowFileFor,
  workflowSourceHash,
} from "./codebase.js";
import {
  buildDigestPrompt,
  isDigestStale,
  renderDigestFile,
  saveDigestFile,
} from "./digest.js";

function parseTitle(title: string): { method: string; endpoint: string } {
  const space = title.indexOf(" ");
  return { method: title.slice(0, space), endpoint: title.slice(space + 1) };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const agent = makeClaudeAgent();

  let regenerated = 0;
  let skipped = 0;
  let failed = 0;

  for (const { title, workflow } of mappedEndpoints()) {
    const { method, endpoint } = parseTitle(title);
    if (!force && !isDigestStale(method, endpoint)) {
      skipped++;
      continue;
    }
    const source = readSource(workflowFileFor(method, endpoint));
    if (!source) {
      console.warn(`! ${title}: workflow source not found (${workflow}) — skipped`);
      failed++;
      continue;
    }
    console.log(`Digesting ${title} (${workflow})…`);
    try {
      const body = await agent(buildDigestPrompt(method, endpoint, source));
      const content = renderDigestFile(
        method,
        endpoint,
        workflow,
        workflowSourceHash(method, endpoint),
        body
      );
      saveDigestFile(method, endpoint, content);
      regenerated++;
    } catch (err) {
      console.error(`! ${title}: agent failed — ${(err as Error).message.slice(0, 200)}`);
      failed++;
    }
  }

  console.log(`\nDigest pass complete.`);
  console.log(`  Regenerated: ${regenerated}`);
  console.log(`  Up-to-date:  ${skipped}`);
  if (failed > 0) console.log(`  Failed:      ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
