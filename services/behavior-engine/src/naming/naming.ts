/**
 * LLM (Sonnet 4.6, `claude-sonnet-4-6` by default) — JUDGMENT ONLY, never
 * classification.
 *
 * Three low-volume judgment calls, per the plan and ADR 0001/0002:
 *   1. Flow naming             — sequence -> human-readable name.
 *   2. Anomaly / contamination — flag out-of-persona endpoints; judge a
 *      guest->customer transition as contamination vs. legitimate transfer.
 *   3. Assertion recommendation — ADVISORY hints on which response fields matter
 *      (BA-F1). This is OPTIONAL METADATA on a candidate, explicitly NOT a
 *      Phase 8/9 oracle. ADR 0001 keeps the OpenAPI spec as the assertion
 *      oracle; these hints never override it. The output contract documents
 *      `assertion_hints` as advisory.
 *
 * Determinism boundary: classification (attributes/persona/signature) is fully
 * deterministic and runs BEFORE this module. The LLM only names and annotates
 * flows that already have a persona. When no API key is present, every call
 * degrades to a deterministic local result so the engine runs end-to-end
 * offline — naming is a convenience, not a gate.
 *
 * Transport: raw HTTPS against the Messages API (no SDK dependency, so the
 * service stays dependency-light and `tsc --noEmit` is clean without an install
 * step). Uses adaptive thinking (valid on Sonnet 4.6), per the claude-api
 * defaults. The model is configurable via `BEHAVIOR_LLM_MODEL`.
 */

import { request } from "node:https";
import type { ScoredFlow } from "../selection/rank.js";
import { rareTransitions, type MarkovModel } from "../mining/markov.js";
import { getEnv } from "../config/env.js";

export const MODEL = getEnv("BEHAVIOR_LLM_MODEL", "claude-sonnet-4-6");
const API_HOST = "api.anthropic.com";
const API_PATH = "/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Max in-flight naming calls — bounded so 30 flows aren't 30 serial round-trips, without hammering rate limits. */
const NAMING_CONCURRENCY = 6;

/** Advisory, non-oracle metadata attached to a candidate (BA-F1). */
export interface AssertionHints {
  /** Response fields the LLM judged worth asserting on. Advisory only. */
  fields: string[];
  /** Source of the hints; "advisory_llm" or "advisory_fallback" when offline. */
  source: "advisory_llm" | "advisory_fallback";
}

export interface FlowAnnotation {
  flow_name: string;
  anomaly_note: string | null;
  assertion_hints: AssertionHints;
}

interface NamingResult {
  flow_name: string;
  anomaly_note: string | null;
  assertion_fields: string[];
}

function apiKey(): string | undefined {
  return getEnv("ANTHROPIC_API_KEY") || undefined;
}

function fallbackName(flow: ScoredFlow): string {
  const tokens = flow.tokens;
  const has = (frag: string) => tokens.some((t) => t.includes(frag));
  const persona = flow.persona.replace("_", " ");
  if (has("/store/carts/{id}/complete")) {
    return `${persona} completes checkout`;
  }
  if (has("/admin/returns")) {
    return "Admin operator processes a return and refund";
  }
  if (has("/admin/orders/{id}/cancel")) {
    return "Admin operator cancels an unfulfilled order";
  }
  if (has("/admin/orders/{id}/fulfillments")) {
    return "Admin operator fulfills an order";
  }
  if (flow.attributes.is_admin) {
    return "Admin operator reviews orders";
  }
  if (flow.attributes.has_errors) {
    return `${persona} hits an error path`;
  }
  if (has("/store/carts")) {
    return `${persona} builds a cart`;
  }
  return `${persona} browses the catalog`;
}

function fallbackAssertionFields(flow: ScoredFlow): string[] {
  const tokens = flow.tokens;
  const fields = new Set<string>();
  for (const token of tokens) {
    if (token.includes("/store/carts")) {
      fields.add("cart.total");
      fields.add("cart.items");
    }
    if (token.includes("/complete")) {
      fields.add("order.status");
      fields.add("order.total");
    }
    if (token.includes("/admin/returns")) {
      fields.add("return.status");
    }
    if (token.includes("/store/products")) {
      fields.add("products.length");
    }
  }
  return [...fields];
}

function promptFor(flow: ScoredFlow, anomalyContext: string): string {
  const steps = flow.steps
    .map((s) => `${s.method} ${s.endpoint} -> ${s.expected_status}`)
    .join("\n");
  return [
    "You are annotating one discovered API flow for a behavioral test suite.",
    `Emergent persona (already classified deterministically): ${flow.persona}.`,
    `Attributes: requires_auth=${flow.attributes.requires_auth}, ` +
      `is_admin=${flow.attributes.is_admin}, has_errors=${flow.attributes.has_errors}.`,
    "Steps (METHOD endpoint -> expected status):",
    steps,
    anomalyContext ? `Low-probability transitions observed: ${anomalyContext}` : "",
    "",
    "Return ONLY a JSON object with exactly these keys:",
    '  "flow_name": a short human-readable name for this journey,',
    '  "anomaly_note": a one-sentence note if this looks like contamination or an',
    "    out-of-persona mix (guest steps then customer steps), else null,",
    '  "assertion_fields": an array of response field names worth asserting on',
    "    (ADVISORY ONLY — the OpenAPI spec remains the oracle).",
    "Do not classify the persona; it is already fixed. Judgment only.",
  ]
    .filter(Boolean)
    .join("\n");
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

function callMessages(prompt: string, key: string): Promise<string | null> {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
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
      }
    );
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

/** Extract the JSON object from an LLM response that may wrap it in prose/fences. */
function parseNaming(text: string): Partial<NamingResult> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as Partial<NamingResult>;
  } catch {
    return null;
  }
}

function fallbackAnnotation(flow: ScoredFlow): FlowAnnotation {
  return {
    flow_name: fallbackName(flow),
    anomaly_note: null,
    assertion_hints: { fields: fallbackAssertionFields(flow), source: "advisory_fallback" },
  };
}

async function annotateOne(
  flow: ScoredFlow,
  key: string,
  markov: MarkovModel
): Promise<FlowAnnotation> {
  const rare = rareTransitions(markov, flow.tokens)
    .map((t) => `${t.from} -> ${t.to} (p=${t.probability.toFixed(3)})`)
    .join("; ");
  const text = await callMessages(promptFor(flow, rare), key);
  const parsed = text ? parseNaming(text) : null;

  if (parsed && typeof parsed.flow_name === "string") {
    return {
      flow_name: parsed.flow_name,
      anomaly_note: typeof parsed.anomaly_note === "string" ? parsed.anomaly_note : null,
      assertion_hints: {
        fields: Array.isArray(parsed.assertion_fields)
          ? parsed.assertion_fields.filter((f): f is string => typeof f === "string")
          : fallbackAssertionFields(flow),
        source: "advisory_llm",
      },
    };
  }
  // Call failed or returned unusable output — fall back, don't crash.
  return fallbackAnnotation(flow);
}

/**
 * Annotate ranked flows (after the skip gate). With no API key, returns
 * deterministic fallbacks for every flow so the run still completes — the
 * `source` on the hints records that they were not LLM-derived. With a key,
 * naming runs through a bounded-concurrency pool (NAMING_CONCURRENCY in flight)
 * so N flows are not N serial round-trips.
 */
export async function annotateFlows(
  flows: ScoredFlow[],
  markov: MarkovModel
): Promise<Map<string, FlowAnnotation>> {
  const key = apiKey();
  const out = new Map<string, FlowAnnotation>();

  if (!key) {
    for (const flow of flows) {
      out.set(flow.signature, fallbackAnnotation(flow));
    }
    return out;
  }

  for (let i = 0; i < flows.length; i += NAMING_CONCURRENCY) {
    const batch = flows.slice(i, i + NAMING_CONCURRENCY);
    const annotations = await Promise.all(batch.map((flow) => annotateOne(flow, key, markov)));
    batch.forEach((flow, j) => out.set(flow.signature, annotations[j]));
  }

  return out;
}

export function llmEnabled(): boolean {
  return apiKey() !== undefined;
}
