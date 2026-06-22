import Anthropic from "@anthropic-ai/sdk";
import type { TrafficConfig } from "../config/config.js";

/**
 * The constrained action vocabulary the LLM may choose from. Keeping the
 * narrative to a known token set makes translation deterministic and robust
 * while still letting the model vary order, selection, and length — the source
 * of "realistic diversity the scripts did not anticipate" (plan §8.2).
 */
export const ACTION_VOCABULARY = [
  "browse_products",
  "view_product",
  "register",
  "login",
  "view_profile",
  "create_cart",
  "add_item",
  "update_item",
  "remove_item",
  "apply_promo",
  "set_address",
  "list_shipping",
  "add_shipping",
  "create_payment_collection",
  "create_payment_session",
  "complete_checkout",
  "view_orders",
  "view_order",
  "abandon",
] as const;

export type Action = (typeof ACTION_VOCABULARY)[number];

export type NarrativeKind = "guest" | "customer" | "mixed";

const PROMPT_TEMPLATE = (kind: NarrativeKind) => `You are simulating a realistic e-commerce shopper interacting with a store API.
Generate a plausible sequence of 5 to 15 API actions a real ${kind} user might take.

Rules:
- Vary the order, skip optional steps sometimes, and occasionally browse without buying.
- Some sessions should abandon a cart partway; some should retry; some should complete checkout.
- A "customer" session must include "register" and "login" before completing checkout.
- A "guest" session must NOT register or log in.
- Only use actions from this exact list (no others):
${ACTION_VOCABULARY.join(", ")}

Respond with ONLY a JSON array of action strings, e.g.:
["browse_products","view_product","create_cart","add_item","abandon"]`;

let cachedClient: Anthropic | null = null;
let warnedNoKey = false;

function getClient(cfg: TrafficConfig): Anthropic | null {
  if (!cfg.anthropicApiKey) {
    if (!warnedNoKey) {
      console.warn(
        "  ! ANTHROPIC_API_KEY not set — using local stochastic narrative fallback for LLM-varied traffic."
      );
      warnedNoKey = true;
    }
    return null;
  }
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: cfg.anthropicApiKey });
  }
  return cachedClient;
}

function sanitize(actions: unknown, kind: NarrativeKind): Action[] {
  const allowed = new Set<string>(ACTION_VOCABULARY);
  const list = Array.isArray(actions)
    ? actions.filter((a): a is Action => typeof a === "string" && allowed.has(a))
    : [];
  if (list.length === 0) {
    return localNarrative(kind);
  }
  if (kind === "guest") {
    return list.filter((a) => a !== "register" && a !== "login" && a !== "view_profile");
  }
  return list;
}

export function localNarrative(kind: NarrativeKind): Action[] {
  const actions: Action[] = ["browse_products", "view_product"];
  if (Math.random() < 0.5) {
    actions.push("view_product");
  }

  if (kind === "customer") {
    actions.push("register", "login");
    if (Math.random() < 0.6) {
      actions.push("view_profile");
    }
  }

  actions.push("create_cart", "add_item");
  if (Math.random() < 0.5) {
    actions.push("add_item");
  }
  if (Math.random() < 0.4) {
    actions.push("update_item");
  }
  if (Math.random() < 0.3) {
    actions.push("remove_item");
  }
  if (Math.random() < 0.4) {
    actions.push("apply_promo");
  }

  if (kind !== "customer" && Math.random() < 0.45) {
    actions.push("abandon");
    return actions;
  }

  actions.push(
    "set_address",
    "list_shipping",
    "add_shipping",
    "create_payment_collection",
    "create_payment_session",
    "complete_checkout",
    "view_order"
  );
  return actions;
}

export async function generateNarrative(
  cfg: TrafficConfig,
  kind: NarrativeKind
): Promise<Action[]> {
  const effectiveKind: NarrativeKind = kind === "mixed" ? (Math.random() < 0.5 ? "guest" : "customer") : kind;
  const client = getClient(cfg);
  if (!client) {
    return localNarrative(effectiveKind);
  }

  try {
    const message = await client.messages.create({
      model: cfg.llmModel,
      max_tokens: 400,
      messages: [{ role: "user", content: PROMPT_TEMPLATE(effectiveKind) }],
    });
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const match = text.match(/\[[\s\S]*\]/);
    const parsed = match ? JSON.parse(match[0]) : null;
    return sanitize(parsed, effectiveKind);
  } catch (error) {
    console.warn(
      `  ! Narrative generation failed (${error instanceof Error ? error.message : String(error)}) — using local fallback.`
    );
    return localNarrative(effectiveKind);
  }
}
