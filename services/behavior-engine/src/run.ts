/**
 * Phase 7 behavior engine CLI.
 *
 *   npm run run -- [--file <path>] [--min-support N] [--quiet]
 *
 * Pipeline (plan §Mining steps, ADR 0002 gate placement):
 *
 *   load (repo-root data/sessions) -> canonical tokens
 *     -> mine (n-gram baseline, PrefixSpan, Markov)
 *     -> assemble + classify mined flows (deterministic; endpoint+status only)
 *     -> dedup (within-run) -> rank -> [SKIP GATE] -> naming (LLM, judgment only)
 *     -> write data/candidates/test-candidates-<runId>.json
 *        write data/validation/classification-report-<runId>.json
 *        print run summary (n-gram vs PrefixSpan, skipped_existing, acceptance)
 *
 * GUARDRAIL: mining/classification never reads role_observed or the session_id
 * source tag. Those reach only validate.ts, after flows/personas exist.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSessions, type SessionFlow } from "./load.js";
import { canonicalTokens, flowSignature } from "./signature.js";
import { classify } from "./persona.js";
import { mineNGrams } from "./ngram.js";
import { minePrefixSpan, decodePattern } from "./prefixspan.js";
import { buildMarkov } from "./markov.js";
import { dedup, type CandidateStep, type MinedFlow } from "./dedup.js";
import { buildCoverageManifest, applySkipGate } from "./coverage.js";
import { rankFlows, priorityOf, type ScoredFlow } from "./rank.js";
import { annotateFlows, llmEnabled, MODEL as NAMING_MODEL } from "./naming.js";
import { buildValidationReport } from "./validate.js";
import { PERSONA_SOURCE, PERSONAS, type Persona } from "./persona.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(__dirname, "..");
const CANDIDATES_DIR = resolve(SERVICE_ROOT, "data", "candidates");
const VALIDATION_DIR = resolve(SERVICE_ROOT, "data", "validation");

const MIN_SUPPORT = 3; // absolute floor (plan §Support threshold), never fractional.

interface Args {
  file?: string;
  minSupport: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { minSupport: MIN_SUPPORT, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--file":
        args.file = argv[++i];
        break;
      case "--min-support":
        args.minSupport = Number.parseInt(argv[++i], 10);
        break;
      case "--quiet":
        args.quiet = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!Number.isFinite(args.minSupport) || args.minSupport < 1) {
    args.minSupport = MIN_SUPPORT;
  }
  return args;
}

/**
 * Per-token modal expected status across the sessions that produced a flow.
 * The signature collapses status, but a candidate step needs a concrete
 * expected status — we take the most common status seen for each
 * `METHOD endpoint` token in the supporting sessions (or 200 as a safe default).
 */
function modalStatuses(sessions: SessionFlow[]): Map<string, number> {
  const counts = new Map<string, Map<number, number>>();
  for (const session of sessions) {
    for (const step of session.steps) {
      const token = `${step.method.toUpperCase()} ${step.endpoint}`;
      let byStatus = counts.get(token);
      if (!byStatus) {
        byStatus = new Map<number, number>();
        counts.set(token, byStatus);
      }
      byStatus.set(step.status, (byStatus.get(step.status) ?? 0) + 1);
    }
  }
  const modal = new Map<string, number>();
  for (const [token, byStatus] of counts) {
    let best = 200;
    let bestCount = -1;
    for (const [status, count] of byStatus) {
      if (count > bestCount) {
        best = status;
        bestCount = count;
      }
    }
    modal.set(token, best);
  }
  return modal;
}

/** Token "METHOD endpoint" -> {method, endpoint}. */
function splitToken(token: string): { method: string; endpoint: string } {
  const sp = token.indexOf(" ");
  return { method: token.slice(0, sp), endpoint: token.slice(sp + 1) };
}

/**
 * Turn a PrefixSpan pattern into a classified MinedFlow. Persona/attributes are
 * derived from the flow's own steps (with the modal expected statuses) — endpoint
 * + status only, no role_observed.
 */
function toMinedFlow(
  tokens: string[],
  support: number,
  modal: Map<string, number>,
  sourceSessions: string[]
): MinedFlow {
  const steps: CandidateStep[] = tokens.map((token) => {
    const { method, endpoint } = splitToken(token);
    return { method, endpoint, expected_status: modal.get(token) ?? 200 };
  });
  // classify() reads {method, endpoint, status} only.
  const { attributes, persona } = classify(
    steps.map((s) => ({ method: s.method, endpoint: s.endpoint, status: s.expected_status })),
    true
  );
  return {
    signature: flowSignature(steps),
    tokens,
    steps,
    support,
    persona,
    attributes,
    source_sessions: sourceSessions,
  };
}

/**
 * Which sessions contain a token sequence as an ordered subsequence (gaps ok).
 * Used to attach provenance + bound source_sessions for a mined pattern.
 */
function supportingSessions(
  tokens: string[],
  sessionTokens: Array<{ id: string; tokens: string[] }>,
  cap = 50
): string[] {
  const out: string[] = [];
  for (const { id, tokens: seq } of sessionTokens) {
    let i = 0;
    for (const t of seq) {
      if (t === tokens[i]) {
        i++;
        if (i === tokens.length) {
          break;
        }
      }
    }
    if (i === tokens.length) {
      out.push(id);
      if (out.length >= cap) {
        break;
      }
    }
  }
  return out;
}

interface Candidate {
  flow_name: string;
  persona: Persona;
  persona_source: typeof PERSONA_SOURCE;
  attributes: MinedFlow["attributes"];
  priority: "high" | "medium" | "low";
  support: number;
  score: number;
  signature: string;
  /** ADVISORY metadata (BA-F1) — NOT a Phase 8/9 oracle (ADR 0001). */
  assertion_hints: { fields: string[]; source: string };
  anomaly_note: string | null;
  source_sessions: string[];
  steps: CandidateStep[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const log = (msg: string) => {
    if (!args.quiet) {
      console.log(msg);
    }
  };

  // --- Load (repo-root data/sessions, newest by default) -------------------
  const { file, sessions } = loadSessions(args.file);
  log(`[behavior-engine] loaded ${sessions.length} session flows from ${file}`);

  // --- Canonical token lists (consecutive dups collapsed by signature.ts) --
  const sessionTokens = sessions.map((s) => ({
    id: s.session_id,
    tokens: canonicalTokens(s.steps),
  }));
  const tokenLists = sessionTokens.map((s) => s.tokens);

  // --- Mine -----------------------------------------------------------------
  const ngrams = mineNGrams(tokenLists, [2, 3, 4], args.minSupport);
  const prefixspan = minePrefixSpan(tokenLists, { minSupport: args.minSupport });
  const markov = buildMarkov(tokenLists);
  log(
    `[behavior-engine] mined ${ngrams.length} n-grams, ` +
      `${prefixspan.patterns.length} PrefixSpan patterns (minSupport=${args.minSupport})`
  );

  // --- Assemble + classify mined flows -------------------------------------
  const modal = modalStatuses(sessions);
  // Keep substantial journeys: PrefixSpan emits every frequent prefix; we want
  // candidates with >=2 steps (a single endpoint is not a flow to test).
  const minedFlows: MinedFlow[] = prefixspan.patterns
    .filter((p) => p.itemIds.length >= 2)
    .map((p) => {
      const tokens = decodePattern(p, prefixspan.vocabulary);
      return toMinedFlow(tokens, p.support, modal, supportingSessions(tokens, sessionTokens));
    });

  // --- Dedup (within-run) ---------------------------------------------------
  const deduped = dedup(minedFlows);
  log(
    `[behavior-engine] dedup: ${minedFlows.length} -> ${deduped.flows.length} ` +
      `(collapsed ${deduped.collapsedIdentical}, clustered ${deduped.clusteredPrefix}, ` +
      `capped ${deduped.cappedOut})`
  );

  // --- Rank -----------------------------------------------------------------
  const ranked: ScoredFlow[] = rankFlows(deduped.flows);

  // --- Cross-run skip gate (ADR 0002) — before LLM -------------------------
  const manifest = buildCoverageManifest();
  const { kept, skipped } = applySkipGate(ranked, manifest);
  log(
    `[behavior-engine] skip gate: ${skipped.length} skipped_existing ` +
      `(manifest: ${manifest.fromTests} from tests, ${manifest.fromHitl} from HITL)`
  );

  // --- LLM naming / anomaly / advisory hints (judgment only) ---------------
  log(
    `[behavior-engine] naming ${kept.length} flows ` +
      `(${llmEnabled() ? `LLM: ${NAMING_MODEL}` : "offline fallback — ANTHROPIC_API_KEY unset"})`
  );
  const annotations = await annotateFlows(kept, markov);

  // --- Build candidates -----------------------------------------------------
  const candidates: Candidate[] = kept.map((flow) => {
    const ann = annotations.get(flow.signature)!;
    return {
      flow_name: ann.flow_name,
      persona: flow.persona,
      persona_source: PERSONA_SOURCE,
      attributes: flow.attributes,
      priority: priorityOf(flow),
      support: flow.support,
      score: Number(flow.score.toFixed(4)),
      signature: flow.signature,
      assertion_hints: { fields: ann.assertion_hints.fields, source: ann.assertion_hints.source },
      anomaly_note: ann.anomaly_note,
      source_sessions: flow.source_sessions,
      steps: flow.steps,
    };
  });

  // --- Validation report ----------------------------------------------------
  const validation = buildValidationReport(runId, sessions, prefixspan, args.minSupport);

  // --- Write outputs --------------------------------------------------------
  mkdirSync(CANDIDATES_DIR, { recursive: true });
  mkdirSync(VALIDATION_DIR, { recursive: true });
  const candidatesPath = resolve(CANDIDATES_DIR, `test-candidates-${runId}.json`);
  const validationPath = resolve(VALIDATION_DIR, `classification-report-${runId}.json`);

  const perPersonaCounts = Object.fromEntries(
    PERSONAS.map((p) => [p, candidates.filter((c) => c.persona === p).length])
  ) as Record<Persona, number>;
  const edgeCandidates = candidates.filter((c) => c.attributes.has_errors);

  writeFileSync(
    candidatesPath,
    `${JSON.stringify(
      {
        run_id: runId,
        source_file: file,
        min_support: args.minSupport,
        generated_at: new Date().toISOString(),
        ngram_vs_prefixspan: {
          ngram_patterns: ngrams.length,
          prefixspan_patterns: prefixspan.patterns.length,
          note:
            "n-gram is the fixed-window baseline (n=2..4); PrefixSpan mines " +
            "variable-length journeys with gaps. Candidates come from PrefixSpan.",
        },
        skipped_existing: skipped.length,
        per_persona_counts: perPersonaCounts,
        candidate_count: candidates.length,
        candidates,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");

  // --- Summary + acceptance gates ------------------------------------------
  const cls = validation.classification;
  const gates = {
    "candidates >= 5": candidates.length >= 5,
    [`holdout support >= ${validation.holdout.floor}`]: validation.holdout.passes,
    "cart signal net-positive (recall up, macro-F1 not down)":
      cls.registered_customer_recall_lift >= 0 && cls.macro_f1_delta >= 0,
    "negative control passes": validation.negative_control.passes,
    "contamination -> highest privilege": validation.contamination.passes,
    ">=1 edge (has_errors) candidate": edgeCandidates.length >= 1,
    "per-persona cap of 10 respected": PERSONAS.every((p) => perPersonaCounts[p] <= 10),
    ">=1 candidate per non-error persona": PERSONAS.every((p) => perPersonaCounts[p] >= 1),
  };

  log("");
  log("[behavior-engine] summary");
  log(`  candidates ............ ${candidates.length}`);
  log(`  per persona ........... ${JSON.stringify(perPersonaCounts)}`);
  log(`  edge candidates ....... ${edgeCandidates.length} (support: ${edgeCandidates.map((c) => c.support).join(",") || "none"})`);
  log(`  skipped_existing ...... ${skipped.length}`);
  log(`  n-gram vs PrefixSpan .. ${ngrams.length} vs ${prefixspan.patterns.length}`);
  log(`  holdout support ....... ${validation.holdout.support} (floor ${validation.holdout.floor})`);
  log(
    `  macro-F1 baseline ..... ${cls.endpoint_only.macroF1.toFixed(4)} | ` +
      `cart-signal ${cls.cart_signal.macroF1.toFixed(4)} (delta ${cls.macro_f1_delta.toFixed(4)})`
  );
  log(`  reg-customer recall ... +${cls.registered_customer_recall_lift.toFixed(4)} from cart signal`);
  log(`  negative control ...... ${validation.negative_control.passes ? "PASS" : "FAIL"}`);
  log("");
  log("[behavior-engine] acceptance gates");
  let allPass = true;
  for (const [name, ok] of Object.entries(gates)) {
    log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) {
      allPass = false;
    }
  }
  log("");
  log(`[behavior-engine] wrote ${candidatesPath}`);
  log(`[behavior-engine] wrote ${validationPath}`);
  if (!allPass) {
    log("[behavior-engine] NOTE: one or more acceptance gates failed (see above).");
  }
}

main().catch((err) => {
  console.error(
    `[behavior-engine] failed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
