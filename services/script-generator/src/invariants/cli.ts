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
import { loadAugmentedSpecs } from "../../../golden/src/oas-source.js";
import type { OasDocument } from "../../../golden/src/oas-types.js";
import { makeClaudeCliAgent, type RepairAgent } from "../repair/agent.js";
import { loadCandidates, type Candidate } from "../load.js";
import type { OasSpecs } from "../resolve.js";
import { readGateContract, stepTitle } from "./codebase.js";
import { digestBodyFor } from "./digest.js";
import { verifyInvariants } from "./evaluate.js";
import {
  buildInvariantPrompt,
  flowCacheKey,
  flowPolarity,
  parseInvariantResponse,
  type ProposalContext,
} from "./propose.js";
import {
  loadInvariants,
  saveInvariants,
  type Invariant,
  type InvariantsArtifact,
} from "./types.js";

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

function proposeForFlow(
  candidate: Candidate,
  specs: OasSpecs,
  agent: RepairAgent,
  ctx: ProposalContext
): Invariant[] {
  const prompt = buildInvariantPrompt(candidate, specs, ctx);
  let response: string;
  try {
    response = agent(prompt);
  } catch (err) {
    console.error(`  ! agent failed for [${candidate.flow_name}] — ${(err as Error).message.slice(0, 160)}`);
    return [];
  }
  return parseInvariantResponse(response, flowPolarity(candidate));
}

function main(): void {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  const verifyIdx = args.indexOf("--verify");
  const verifyPath = verifyIdx >= 0 ? args[verifyIdx + 1] : undefined;
  const force = args.includes("--force");

  const specs: OasSpecs = loadAugmentedSpecs() as { store: OasDocument; admin: OasDocument };
  const candidates = loadCandidates().candidates.filter((c) => {
    // Happy AND error flows are now in scope: error flows get failure-body
    // invariants ("blocked for the right reason"), happy flows get success ones.
    if (only && !c.flow_name.toLowerCase().includes(only.toLowerCase())) return false;
    return true;
  });

  const agent = makeClaudeCliAgent();
  const knownGood = verifyPath ? bodiesFromRun(verifyPath) : null;

  const existing = loadInvariants();
  const artifact: InvariantsArtifact = { generated_at: new Date().toISOString(), flows: {} };

  let proposed = 0;
  let verified = 0;
  let cached = 0;
  for (const candidate of candidates) {
    const ctx = buildContext(candidate);
    const cacheKey = flowCacheKey(candidate, specs, ctx);
    const prior = existing.flows[candidate.signature];

    // Template-cache hit: identical prompt inputs -> reuse the prior proposal
    // (and its verified state) without spending an agent call.
    if (!force && prior && prior.cache_key === cacheKey) {
      artifact.flows[candidate.signature] = prior;
      cached++;
      continue;
    }

    const polarity = flowPolarity(candidate);
    console.log(`Proposing ${polarity}-path invariants for [${candidate.flow_name}]…`);
    let invariants = proposeForFlow(candidate, specs, agent, ctx);
    proposed += invariants.length;
    if (knownGood) {
      const bodies = knownGood.get(candidate.signature) ?? new Map<string, unknown>();
      invariants = verifyInvariants(invariants, bodies);
      verified += invariants.filter((i) => i.verified).length;
    }
    artifact.flows[candidate.signature] = {
      flow_name: candidate.flow_name,
      cache_key: cacheKey,
      proposed_at: new Date().toISOString(),
      invariants,
    };
  }

  saveInvariants(artifact);
  console.log(`\nInvariant proposal complete.`);
  console.log(`  Flows processed:     ${candidates.length}`);
  console.log(`  Reused from cache:   ${cached}`);
  console.log(`  Invariants proposed: ${proposed}`);
  if (knownGood) {
    console.log(`  Verified (baked):    ${verified}`);
  } else if (proposed > 0) {
    console.log(`  (proposals written as verified:false — re-run with --verify <normalized.json> to bake)`);
  }
}

main();
