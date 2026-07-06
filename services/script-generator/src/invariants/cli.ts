#!/usr/bin/env node
/**
 * Invariant proposal CLI — the AI step that enriches generated tests beyond
 * status codes.
 *
 *   tsx src/invariants/cli.ts                  # propose for every flow (happy + error)
 *   tsx src/invariants/cli.ts --only checkout  # scope to flows whose name matches
 *   tsx src/invariants/cli.ts --force          # ignore the template cache, re-propose all
 *   tsx src/invariants/cli.ts --verify reports/playwright/normalized.json
 *                                              # bake only invariants that held on
 *                                              # that known-good run
 *
 * Pipeline (each phase is honest about what it does):
 *   1. PROPOSE  — for each flow, ask the agent for structured invariants (never
 *                 code). The agent reads the flow + OAS shape + the codebase
 *                 context (custom auth gate + per-endpoint behavior digest). Happy
 *                 flows get success-body invariants; error flows get failure-body
 *                 ones ("blocked for the RIGHT reason"). Written verified:false.
 *   2. VERIFY   — replay the proposals against a known-good run's captured bodies
 *                 (normalized.json). Only invariants that HELD flip to
 *                 verified:true; the rest stay dropped. The anti-hallucination gate.
 *   3. GENERATE — `npm run generate` reads the artifact and renders the verified
 *                 invariants deterministically (no LLM at generate time).
 *
 * Template cache (cache #2): each flow stores a cache_key over its prompt inputs
 * (flow signature + OAS shape + gate-contract + behavior digest + prompt version).
 * A flow whose key is unchanged is reused without an agent call — the LLM rides
 * the authoring path, not every run.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { loadAugmentedSpecs } from "../../../golden/src/oas-source.js";
import type { OasDocument } from "../../../golden/src/oas-types.js";
import { makeClaudeAgent, type RepairAgent } from "../repair/agent.js";
import { loadCandidates, type Candidate } from "../load.js";
import type { OasSpecs } from "../resolve.js";
import { readGateContract, stepTitle } from "./codebase.js";
import { digestBodyFor } from "./digest.js";
import { evaluateInvariant } from "./evaluate.js";
import {
  buildInvariantPrompt,
  flowCacheKey,
  flowPolarity,
  parseInvariantResponse,
  type ProposalContext,
} from "./propose.js";
import {
  invariantId,
  loadInvariants,
  REPO_ROOT,
  storedInvariant,
  type Invariant,
} from "./types.js";
import { storage } from "../../../../packages/storage/index.js";

/** Build, per flow_signature, the captured response body for each step title from
 * a known-good normalized.json run (test-runner collect output). */
function bodiesFromRun(normalizedPath: string): Map<string, Map<string, unknown>> {
  const out = new Map<string, Map<string, unknown>>();
  const report = JSON.parse(readFileSync(normalizedPath, "utf8")) as {
    tests?: Array<{ flow_signature: string | null; steps?: Array<{ endpoint: string; response_body?: string | null }> }>;
  };
  for (const test of report.tests ?? []) {
    if (!test.flow_signature) continue;
    const byStep = out.get(test.flow_signature) ?? new Map<string, unknown>();
    for (const step of test.steps ?? []) {
      if (!step.response_body) continue;
      try {
        byStep.set(step.endpoint, JSON.parse(step.response_body));
      } catch {
        // non-JSON body excerpt — skip; the invariant stays unverified
      }
    }
    out.set(test.flow_signature, byStep);
  }
  return out;
}

/** Assemble the codebase context the proposal agent reads for a flow: the custom
 * auth gate (verbatim) + each step's behavior digest (cache #1). */
function buildContext(candidate: Candidate): ProposalContext {
  const digestByStep = new Map<string, string>();
  for (const s of candidate.steps) {
    const body = digestBodyFor(s.method, s.endpoint);
    if (body) digestByStep.set(stepTitle(s.method, s.endpoint), body);
  }
  return { gateContract: readGateContract(), digestByStep };
}

/** Populate ANTHROPIC_API_KEY from the repo-root `.env` when it's not already in
 * the environment. The agent SDK needs it, but this CLI is often spawned (e.g.
 * `npm --prefix …`, or the dashboard job runner) without the key exported — in
 * which case every proposal fails `error_during_execution` and the run silently
 * bakes nothing. Mirrors behavior-engine's precedence: process.env wins. */
function ensureAnthropicKey(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  try {
    const envText = readFileSync(resolvePath(REPO_ROOT, ".env"), "utf8");
    const match = /^ANTHROPIC_API_KEY=(.*)$/m.exec(envText);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value) process.env.ANTHROPIC_API_KEY = value;
  } catch {
    // No repo-root .env — leave unset; the run will surface the agent failures loudly.
  }
}

async function proposeForFlow(
  candidate: Candidate,
  specs: OasSpecs,
  agent: RepairAgent,
  ctx: ProposalContext
): Promise<{ invariants: Invariant[]; failed: boolean }> {
  const prompt = buildInvariantPrompt(candidate, specs, ctx);
  let response: string;
  try {
    response = await agent(prompt);
  } catch (err) {
    console.error(`  ! agent failed for [${candidate.flow_name}] — ${(err as Error).message.slice(0, 160)}`);
    return { invariants: [], failed: true };
  }
  return { invariants: parseInvariantResponse(response, flowPolarity(candidate)), failed: false };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  const verifyIdx = args.indexOf("--verify");
  const verifyArg = verifyIdx >= 0 ? args[verifyIdx + 1] : undefined;
  // Resolve a relative report path against the repo root, not the CWD: this CLI is
  // spawned via `npm --prefix …` whose working directory is not the repo root.
  const verifyPath = verifyArg
    ? isAbsolute(verifyArg)
      ? verifyArg
      : resolvePath(process.env.STORAGE_WORKSPACE_ROOT ?? REPO_ROOT, verifyArg)
    : undefined;
  const force = args.includes("--force");

  if (verifyIdx >= 0 && !verifyPath) {
    throw new Error("--verify requires a normalized report path");
  }

  // Verification is deliberately a separate, incremental operation. It never
  // loads candidates, computes cache keys, or invokes the proposal agent.
  if (verifyPath) {
    const knownGood = bodiesFromRun(verifyPath);
    const existing = await loadInvariants();
    const heldIds: string[] = [];
    let evaluated = 0;
    for (const [flowSignature, flow] of Object.entries(existing.flows)) {
      const bodies = knownGood.get(flowSignature);
      if (!bodies) continue;
      for (const invariant of flow.invariants) {
        if (!bodies.has(invariant.stepTitle)) continue;
        evaluated += 1;
        if (evaluateInvariant(bodies.get(invariant.stepTitle), invariant).pass) {
          heldIds.push(invariant.id ?? invariantId(flowSignature, invariant));
        }
      }
    }
    const updated = await storage.invariants.markVerified(heldIds);
    console.log("\nInvariant verification complete.");
    console.log(`  Invariants evaluated: ${evaluated}`);
    console.log(`  Held on baseline:     ${heldIds.length}`);
    console.log(`  Rows marked verified: ${updated}`);
    return;
  }

  const specs: OasSpecs = loadAugmentedSpecs() as { store: OasDocument; admin: OasDocument };
  const candidates = loadCandidates().candidates.filter((c) => {
    // Happy AND error flows are now in scope: error flows get failure-body
    // invariants ("blocked for the right reason"), happy flows get success ones.
    if (only && !c.flow_name.toLowerCase().includes(only.toLowerCase())) return false;
    return true;
  });

  ensureAnthropicKey();
  const agent = makeClaudeAgent();

  const existing = await loadInvariants();

  let proposed = 0;
  let cached = 0;

  // Partition first: a template-cache hit (identical prompt inputs) reuses the
  // prior PROPOSAL with no agent call. Everything else is a "miss" that needs an
  // LLM round-trip.
  const misses: { candidate: Candidate; ctx: ProposalContext; cacheKey: string }[] = [];
  for (const candidate of candidates) {
    const ctx = buildContext(candidate);
    const cacheKey = flowCacheKey(candidate, specs, ctx);
    const prior = existing.flows[candidate.signature];
    if (!force && prior && prior.cache_key === cacheKey) {
      cached++;
      continue;
    }
    misses.push({ candidate, ctx, cacheKey });
  }

  // Propose for misses with BOUNDED CONCURRENCY: each flow's proposal is
  // independent. Each completed flow is replaced in one storage transaction;
  // unrelated flows and cache hits are never rewritten.
  const concurrency = Math.max(1, Number(process.env.INVARIANT_CONCURRENCY) || 4);
  let cursor = 0;
  let agentErrors = 0;
  async function worker(): Promise<void> {
    while (cursor < misses.length) {
      const { candidate, ctx, cacheKey } = misses[cursor++];
      const polarity = flowPolarity(candidate);
      console.log(`Proposing ${polarity}-path invariants for [${candidate.flow_name}]…`);
      const result = await proposeForFlow(candidate, specs, agent, ctx);
      if (result.failed) {
        agentErrors++;
        continue;
      }
      const invariants = result.invariants;
      proposed += invariants.length;
      const proposedAt = new Date().toISOString();
      await storage.invariants.replaceFlow({
        flow_signature: candidate.signature,
        flow_name: candidate.flow_name,
        cache_key: cacheKey,
        proposed_at: proposedAt,
        invariants: invariants.map((invariant) =>
          storedInvariant(
            candidate.signature,
            candidate.flow_name,
            cacheKey,
            proposedAt,
            invariant
          )
        ),
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, misses.length) }, () => worker()));

  console.log(`\nInvariant proposal complete.`);
  console.log(`  Flows processed:     ${candidates.length}`);
  console.log(`  Reused from cache:   ${cached}`);
  console.log(`  Agent calls:         ${misses.length} (${agentErrors} failed)`);
  console.log(`  Invariants proposed: ${proposed}`);
  if (proposed > 0) {
    console.log(`  (proposals written as verified:false — re-run with --verify <normalized.json> to bake)`);
  }

  // A total wipeout is a config/auth failure (e.g. no ANTHROPIC_API_KEY), NOT a
  // legitimate "no invariants" result — fail loudly so the pipeline stops instead
  // of proceeding with silently un-enriched tests.
  if (misses.length > 0 && agentErrors === misses.length) {
    console.error(
      `\n✗ Every agent call failed (${agentErrors}/${misses.length}). ` +
        `Likely a missing ANTHROPIC_API_KEY or agent-SDK config — nothing was proposed.`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
