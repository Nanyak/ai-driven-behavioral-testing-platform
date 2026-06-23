/**
 * LLM triage — JUDGMENT ONLY, advisory, off the gate path (ADR 0001/0005).
 *
 * Transport mirrors services/behavior-engine/src/naming/naming.ts: raw HTTPS to
 * the Messages API (no SDK, so `tsc --noEmit` stays clean with no install step),
 * adaptive thinking (valid on Sonnet 4.6), bounded concurrency, and a graceful
 * degrade to the deterministic heuristic on any failure or unusable output. The
 * model is configurable via TRIAGE_LLM_MODEL (default claude-sonnet-4-6;
 * claude-opus-4-8 is a defensible opt-in since triage is failures-only and
 * low-volume).
 */
import { request } from "node:https";
import { getEnv } from "./env.js";
import { heuristicVerdict } from "./heuristic.js";
import { CONFIDENCES, VERDICTS, type Confidence, type EvidenceBundle, type TriageVerdict, type Verdict } from "./types.js";

export const MODEL = getEnv("TRIAGE_LLM_MODEL", "claude-sonnet-4-6");
const API_HOST = "api.anthropic.com";
const API_PATH = "/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Bounded so a many-failure red run isn't N serial round-trips, without hammering rate limits. */
const TRIAGE_CONCURRENCY = 6;
/**
 * Adaptive thinking + the JSON answer must BOTH fit here. 1024 was too tight:
 * on ambiguous failures the thinking block alone consumed the whole budget,
 * truncating the answer (stop_reason "max_tokens") and forcing a heuristic
 * fallback. 3072 leaves ample headroom — natural completions use ~600-1000 and
 * only draw what they need, so this raises the ceiling, not the typical cost.
 */
const MAX_TOKENS = 3072;

const SYSTEM_PROMPT = [
  "You triage ONE failing API regression test and classify why it failed.",
  "You are ADVISORY ONLY: the OpenAPI-derived golden schema is the assertion oracle, not you.",
  "Do NOT propose changing the gate, the oracle, or the persona classification — only explain this failure.",
  "",
  "Classify into exactly one verdict:",
  "- real_regression: behaviour broke (stable endpoint 2xx->5xx, or a REQUIRED field vanished, or a breaking type change).",
  "- contract_drift: the SUT changed intentionally and the golden is now stale (often a purely additive/new field).",
  "- test_artifact: the generated spec/setup is at fault (auth/gate eligibility, a captured-id dependency, a flake), not the SUT.",
  "- uncertain: the evidence does not support a confident call; a human should look.",
  "",
  'Return ONLY a JSON object: {"verdict": <one of the four>, "confidence": "low"|"medium"|"high", "rationale": <one or two sentences citing the specific field/status>, "recommended_action": <the concrete next step>}.',
].join("\n");

function userPrompt(e: EvidenceBundle): string {
  const evidence = {
    endpoint: e.endpoint,
    expected_status: e.expected_status,
    actual_status: e.actual_status,
    golden_diff: e.golden_diff,
    required_fields_missing: e.required_missing,
    failure_message: e.failure_message,
    response_body_excerpt: e.response_body_excerpt,
    persona: e.persona,
    flow: e.flow_name,
  };
  return `Triage this failure:\n${JSON.stringify(evidence, null, 2)}`;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

function callMessages(prompt: string, key: string): Promise<string | null> {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  return new Promise((resolve) => {
    const req = request(
      {
        host: API_HOST,
        path: API_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 300) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicResponse;
            const text = (parsed.content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join("");
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asVerdict(value: unknown): Verdict | null {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value) ? (value as Verdict) : null;
}

function asConfidence(value: unknown): Confidence {
  if (typeof value === "string" && (CONFIDENCES as readonly string[]).includes(value)) return value as Confidence;
  // Some responses return a 0-1 score instead of a band — map it rather than
  // silently defaulting to "medium" and losing the model's signal.
  if (typeof value === "number") return value >= 0.8 ? "high" : value >= 0.5 ? "medium" : "low";
  return "medium";
}

function evidenceSummary(e: EvidenceBundle): TriageVerdict["evidence"] {
  const d = e.golden_diff;
  return {
    endpoint: e.endpoint,
    expected_status: e.expected_status,
    actual_status: e.actual_status,
    diff_paths: d ? [...d.missing, ...d.unexpected, ...d.type_changed] : [],
    required_missing: e.required_missing,
  };
}

/** Deterministic fallback verdict, stamped with the failure id + evidence. */
function fromHeuristic(e: EvidenceBundle): TriageVerdict {
  const h = heuristicVerdict(e);
  return { failure_id: e.failure_id, ...h, evidence: evidenceSummary(e) };
}

async function triageOne(e: EvidenceBundle, key: string): Promise<TriageVerdict> {
  const text = await callMessages(userPrompt(e), key);
  const parsed = text ? parseJsonObject(text) : null;
  const verdict = parsed ? asVerdict(parsed.verdict) : null;
  if (!parsed || !verdict) return fromHeuristic(e); // unusable output -> heuristic, never crash

  return {
    failure_id: e.failure_id,
    verdict,
    confidence: asConfidence(parsed.confidence),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "(no rationale returned)",
    recommended_action:
      typeof parsed.recommended_action === "string" ? parsed.recommended_action : "Review the failure manually.",
    evidence: evidenceSummary(e),
  };
}

/**
 * Verdicts for every evidence bundle. With no key, returns deterministic
 * heuristic verdicts for all (so triage runs offline / in CI). With a key, runs
 * the LLM through a bounded-concurrency pool, each call degrading to the
 * heuristic on failure.
 */
export async function triageAll(evidence: EvidenceBundle[]): Promise<{ verdicts: TriageVerdict[]; model: string }> {
  const key = getEnv("ANTHROPIC_API_KEY") || undefined;

  if (!key) {
    return { verdicts: evidence.map(fromHeuristic), model: "offline-heuristic" };
  }

  const verdicts: TriageVerdict[] = [];
  for (let i = 0; i < evidence.length; i += TRIAGE_CONCURRENCY) {
    const batch = evidence.slice(i, i + TRIAGE_CONCURRENCY);
    verdicts.push(...(await Promise.all(batch.map((e) => triageOne(e, key)))));
  }
  return { verdicts, model: MODEL };
}
