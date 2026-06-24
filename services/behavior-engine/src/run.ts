/**
 * Behavior engine CLI.
 *
 *   npm run run -- [--file <path>] [--min-support N] [--quiet]
 *
 * Pipeline (ADR 0002 gate placement):
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

import { loadSessions, type SessionFlow } from "./io/sessions.js";
import { canonicalTokens, flowSignature } from "./signature/signature.js";
import { classify } from "./classification/persona.js";
import { mineNGrams } from "./mining/ngram.js";
import { minePrefixSpan, decodePattern } from "./mining/prefixspan.js";
import { buildMarkov } from "./mining/markov.js";
import { dedup, capRankedPerPersona, type CandidateStep, type MinedFlow } from "./selection/dedup.js";
import { buildCoverageManifest, applySkipGate } from "./selection/coverage.js";
import { rankFlows, priorityOf, type ScoredFlow } from "./selection/rank.js";
import { annotateFlows, llmEnabled, MODEL as NAMING_MODEL } from "./naming/naming.js";
import { buildValidationReport } from "./validation/validate.js";
import { PERSONA_SOURCE, PERSONAS, type Persona } from "./classification/persona.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(__dirname, "..");
const CANDIDATES_DIR = resolve(SERVICE_ROOT, "data", "candidates");
const VALIDATION_DIR = resolve(SERVICE_ROOT, "data", "validation");

const MIN_SUPPORT = 3; // absolute floor, never fractional.

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

function splitToken(token: string): { method: string; endpoint: string } {
  const sp = token.indexOf(" ");
  return { method: token.slice(0, sp), endpoint: token.slice(sp + 1) };
}

// JS string coercions a failed client-side id interpolation leaves in a URL path
// (`/store/carts/${cart.id}` with cart.id === undefined). Mirrors the noise filter
// in log-ingestion/pipeline.ts; kept here so the engine also rejects already-ingested
// captures that still carry these literal segments.
const BROKEN_INTERPOLATION_SEGMENTS = new Set(["undefined", "null", "NaN", "[object Object]"]);

function hasBrokenInterpolationSegment(flow: MinedFlow): boolean {
  return flow.steps.some((step) =>
    step.endpoint.split("/").some((segment) => BROKEN_INTERPOLATION_SEGMENTS.has(segment))
  );
}

/**
 * Turn a PrefixSpan pattern into a classified MinedFlow. Persona/attributes are
 * derived from the flow's own steps (with the modal expected statuses) — endpoint
 * + status only, no role_observed.
 *
 * Option B (auth-context-coherent modal): the per-token modal is taken over only
 * the supporting sessions whose OWN emergent persona matches the flow's, so a
 * gated endpoint's expected status reflects THIS flow's auth context. Without it,
 * a customer checkout's `POST /store/carts` inherits the guest 401 that dominates
 * the unpartitioned modal (the supporting set mixes guest attempts with customer
 * successes), and the generated test then expects 401 while the authenticated run
 * returns 200. Partitioning by the session's own context keeps each journey
 * internally consistent: expected status and the persona the test runs under no
 * longer disagree.
 */
function toMinedFlow(
  tokens: string[],
  support: number,
  supporting: SessionFlow[],
  sessionPersona: Map<string, Persona>
): MinedFlow {
  const stepsFrom = (sessions: SessionFlow[]): CandidateStep[] => {
    const modal = modalStatuses(sessions);
    return tokens.map((token) => {
      const { method, endpoint } = splitToken(token);
      return { method, endpoint, expected_status: modal.get(token) ?? 200 };
    });
  };
  // classify() reads {method, endpoint, status} only. Production rule = the full
  // status-derived signal: cart-mutation signal AND auth-gated-read signal (ADR 0006).
  const asStatus = (steps: CandidateStep[]) =>
    steps.map((s) => ({ method: s.method, endpoint: s.endpoint, status: s.expected_status }));

  // Provisional persona over ALL supporting sessions identifies the flow's auth
  // context; then restrict the modal to the supporting sessions whose own context
  // matches. Falls back to the full set if none match (never lose the journey).
  const provisional = classify(asStatus(stepsFrom(supporting)), true, true).persona;
  const matched = supporting.filter((s) => sessionPersona.get(s.session_id) === provisional);
  const steps = stepsFrom(matched.length > 0 ? matched : supporting);

  const { attributes, persona } = classify(asStatus(steps), true, true);
  return {
    signature: flowSignature(steps),
    tokens,
    steps,
    support,
    persona,
    attributes,
    source_sessions: supporting.map((s) => s.session_id),
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
  /** ADVISORY metadata — NOT a golden oracle (ADR 0001). */
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

  const { file, sessions } = loadSessions(args.file);
  log(`[behavior-engine] loaded ${sessions.length} session flows from ${file}`);

  const sessionTokens = sessions.map((s) => ({
    id: s.session_id,
    tokens: canonicalTokens(s.steps),
  }));
  const tokenLists = sessionTokens.map((s) => s.tokens);

  const ngrams = mineNGrams(tokenLists, [2, 3, 4], args.minSupport);
  const prefixspan = minePrefixSpan(tokenLists, { minSupport: args.minSupport });
  const markov = buildMarkov(tokenLists);
  log(
    `[behavior-engine] mined ${ngrams.length} n-grams, ` +
      `${prefixspan.patterns.length} PrefixSpan patterns (minSupport=${args.minSupport})`
  );

  // Expected status per token is computed from the flow's OWN supporting
  // sessions, NOT globally, and further restricted to the supporting sessions
  // whose auth context matches the flow's (Option B, see toMinedFlow): a token
  // like `POST /store/carts` is 401 globally (guests attempt it far more than
  // customers succeed) AND 401 across a supporting set that mixes guest attempts
  // with customer successes, but inside a customer checkout it is 200. Stamping
  // the contaminated 401 on a clean customer journey mis-flags it has_errors and
  // makes the generated test expect 401 where the authenticated run returns 200.
  const sessionById = new Map(sessions.map((s) => [s.session_id, s]));
  // Each session's OWN emergent auth context (endpoint+status only, no
  // role_observed), memoized once. This is a per-session classification used to
  // partition expected-status modals — it never feeds persona classification of
  // the mined flow beyond the same emergent signal already in use.
  const sessionPersona = new Map<string, Persona>(
    sessions.map((s) => [
      s.session_id,
      classify(s.steps.map((st) => ({ method: st.method, endpoint: st.endpoint, status: st.status })), true, true)
        .persona,
    ])
  );
  // Keep substantial journeys: PrefixSpan emits every frequent prefix; we want
  // candidates with >=2 steps (a single endpoint is not a flow to test).
  const minedFlows: MinedFlow[] = prefixspan.patterns
    .filter((p) => p.itemIds.length >= 2)
    .map((p) => {
      const tokens = decodePattern(p, prefixspan.vocabulary);
      const supporting = supportingSessions(tokens, sessionTokens)
        .map((id) => sessionById.get(id))
        .filter((s): s is SessionFlow => s !== undefined);
      return toMinedFlow(tokens, p.support, supporting, sessionPersona);
    })
    // Defense-in-depth: a flow whose signature depends on a malformed URL — a path
    // segment left by a failed client-side id interpolation (`/store/carts/undefined`,
    // from a cart that never got created) — is a broken capture, not a behavior, and
    // tends to surface as an all-failure "error path" thrash mislabeled by persona.
    // Ingestion now drops these steps at the source (log-ingestion/pipeline.ts); this
    // guard also removes already-ingested ones so a re-mine of existing data/sessions
    // does not resurface the artifact.
    .filter((flow) => !hasBrokenInterpolationSegment(flow));

  const deduped = dedup(minedFlows);
  log(
    `[behavior-engine] dedup: ${minedFlows.length} -> ${deduped.flows.length} ` +
      `(collapsed ${deduped.collapsedIdentical}, subsumed ${deduped.subsumed})`
  );

  // Rank, THEN cap per persona by score, so the cap keeps the highest-value
  // flows rather than whichever fragments have the most raw volume.
  const rankedAll: ScoredFlow[] = rankFlows(deduped.flows);
  const { kept: ranked, cappedOut } = capRankedPerPersona(rankedAll);
  log(`[behavior-engine] per-persona cap: ${rankedAll.length} -> ${ranked.length} (capped ${cappedOut})`);

  const manifest = buildCoverageManifest();
  const { kept, skipped } = applySkipGate(ranked, manifest);
  log(
    `[behavior-engine] skip gate: ${skipped.length} skipped_existing ` +
      `(manifest: ${manifest.fromTests} from tests, ${manifest.fromHitl} from HITL)`
  );

  log(
    `[behavior-engine] naming ${kept.length} flows ` +
      `(${llmEnabled() ? `LLM: ${NAMING_MODEL}` : "offline fallback — ANTHROPIC_API_KEY unset"})`
  );
  const annotations = await annotateFlows(kept, markov);

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

  const validation = buildValidationReport(runId, sessions, prefixspan, args.minSupport);

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

  const cls = validation.classification;
  const gates = {
    "candidates >= 5": candidates.length >= 5,
    [`holdout support >= ${validation.holdout.floor}`]: validation.holdout.passes,
    "cart signal net-positive (recall up, macro-F1 not down)":
      cls.registered_customer_recall_lift >= 0 && cls.macro_f1_delta >= 0,
    "read signal net-positive (recall up, macro-F1 not down)":
      cls.read_signal.registered_customer_recall_lift >= 0 &&
      cls.read_signal.macro_f1_delta >= 0,
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
      `cart-signal ${cls.cart_signal.macroF1.toFixed(4)} (delta ${cls.macro_f1_delta.toFixed(4)}) | ` +
      `+read ${cls.cart_read_signal.macroF1.toFixed(4)} (delta ${cls.read_signal.macro_f1_delta.toFixed(4)})`
  );
  log(
    `  reg-customer recall ... +${cls.registered_customer_recall_lift.toFixed(4)} from cart signal, ` +
      `+${cls.read_signal.registered_customer_recall_lift.toFixed(4)} from read signal`
  );
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
