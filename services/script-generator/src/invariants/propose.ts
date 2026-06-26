/**
 * Invariant proposal (the AI half of the behavioral layer).
 *
 * The agent reads a flow (its ordered steps + the OAS response shape for each
 * step) and PROPOSES behavioral invariants as STRUCTURED JSON — never test code.
 * This is the deliberate guardrail: a structured proposal can be schema-checked
 * (isValidInvariant), verified against the live backend, and rendered
 * deterministically (render.ts), so a hallucinated matcher or a wrong field is
 * caught instead of silently executing. The agent never sees or touches the
 * status oracle.
 *
 * The agent backend is injectable (`RepairAgent` from repair/agent.ts) so this
 * module is unit-testable with a stub and the CLI can swap the live `claude` CLI.
 */
import { createHash } from "node:crypto";
import type { OasDocument, OasMethod, OasSchema } from "../../../golden/src/oas-types.js";
import { isRefSchema } from "../../../golden/src/oas-types.js";
import type { Candidate } from "../load.js";
import type { OasSpecs } from "../resolve.js";
import { stepTitle } from "./codebase.js";
import { APPROVED_TEMPLATE_NAMES, isValidInvariant, type Invariant } from "./types.js";

/** Bumped whenever the prompt CONTRACT changes (so the template cache, keyed in
 * part on this, invalidates and the agent re-proposes). v2 added the codebase
 * context (gate-contract + behavior digest) and the error-path mode. */
export const PROMPT_VERSION = "2";

/** Codebase context fed to the proposal agent for a flow (built by the CLI from
 * codebase.ts + digest.ts; stubbed in unit tests). The agent reads the DIGEST,
 * never raw core-flows source; the gate-contract is small enough to pass verbatim. */
export interface ProposalContext {
  /** The custom auth-gate source, or null when unavailable. */
  gateContract: string | null;
  /** Per-step behavior-digest body, keyed by emitted step title. */
  digestByStep: Map<string, string>;
}

export const EMPTY_CONTEXT: ProposalContext = { gateContract: null, digestByStep: new Map() };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Compact response-shape hint for a step: the top-level field names of its
 * success response, so the agent proposes paths that actually exist. Best-effort:
 * an undocumented endpoint simply yields no hint (the agent still has the path). */
function responseFieldHint(specs: OasSpecs, method: string, endpoint: string, status: number): string[] {
  for (const doc of [specs.store, specs.admin]) {
    const operation = doc.paths[endpoint]?.[method.toLowerCase() as OasMethod];
    const responses = (operation as { responses?: Record<string, { content?: Record<string, { schema?: OasSchema }> }> } | undefined)
      ?.responses;
    const schema = responses?.[String(status)]?.content?.["application/json"]?.schema;
    if (!schema) continue;
    const names = topLevelFieldNames(doc, schema);
    if (names.length > 0) return names;
  }
  return [];
}

function topLevelFieldNames(doc: OasDocument, schema: OasSchema): string[] {
  let node: OasSchema = schema;
  if (isRefSchema(node)) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(node.$ref);
    const resolved = match ? doc.components.schemas[match[1]] : undefined;
    if (!resolved) return [];
    node = resolved;
  }
  if ("allOf" in node && node.allOf) {
    return node.allOf.flatMap((b) => topLevelFieldNames(doc, b));
  }
  if ("properties" in node && node.properties) {
    return Object.keys(node.properties);
  }
  return [];
}

/** A flow is an error-path flow (assert on the FAILURE body) vs a happy-path
 * flow (assert successful behavior). Drives prompt mode + the stamped polarity. */
export function flowPolarity(candidate: Candidate): "success" | "error" {
  return candidate.attributes.has_errors ? "error" : "success";
}

const MATCHER_LINE =
  '- "matcher" must be ONE of: toBe, toEqual, toBeGreaterThan, toBeGreaterThanOrEqual,\n' +
  "  toBeLessThan, toBeLessThanOrEqual, toBeTruthy, toBeDefined, toContain.\n" +
  '- Include "expected" for every matcher EXCEPT toBeTruthy/toBeDefined (which take no argument).';

const OUTPUT_LINE =
  "Output ONLY a JSON array, no prose, no code fences. Each element must be ONE of:\n" +
  '{ "kind": "field", "stepTitle": string, "path": string, "matcher": string, "expected"?: string|number|boolean, "rationale": string }\n' +
  '{ "kind": "template", "template": string, "stepTitle": string, "path": string, "rationale": string }\n' +
  "Approved templates: " + APPROVED_TEMPLATE_NAMES.join(", ") + ".\n" +
  "If no approved field or template invariant is sound, output [].";

/** The per-step "behavior the handler code exhibits" block — the digest is what
 * lets the agent propose invariants the OAS shape can't express (side effects,
 * the success discriminator). Empty string when no digest covers any step. */
function codebaseContextBlock(candidate: Candidate, ctx: ProposalContext): string {
  const parts: string[] = [];
  if (ctx.gateContract) {
    parts.push(
      "Custom auth gate (project source — the OAS does NOT describe this):\n" +
        "```ts\n" +
        ctx.gateContract.slice(0, 4_000) +
        "\n```"
    );
  }
  const seen = new Set<string>();
  for (const s of candidate.steps) {
    const title = stepTitle(s.method, s.endpoint);
    const digest = ctx.digestByStep.get(title);
    if (!digest || seen.has(title)) continue;
    seen.add(title);
    parts.push(`Endpoint behavior — "${title}" (distilled from handler code):\n${digest}`);
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

/** Build the agent prompt for one flow. Lists each step (the EMITTED step title,
 * so proposed `stepTitle` values line up with what emit renders) plus its
 * response field hint and the codebase-derived behavior, and pins the output
 * contract hard. Mode follows the flow's polarity: happy flows assert SUCCESS
 * behavior, error flows assert the FAILURE body. */
export function buildInvariantPrompt(
  candidate: Candidate,
  specs: OasSpecs,
  ctx: ProposalContext = EMPTY_CONTEXT
): string {
  const steps = candidate.steps
    .map((s) => {
      const title = `${s.method} ${s.endpoint}`;
      const hint = responseFieldHint(specs, s.method, s.endpoint, s.expected_status);
      const fields = hint.length > 0 ? ` — response top-level fields: ${hint.join(", ")}` : "";
      return `- "${title}" (expects HTTP ${s.expected_status})${fields}`;
    })
    .join("\n");
  const context = codebaseContextBlock(candidate, ctx);

  if (flowPolarity(candidate) === "error") {
    return `You are auditing a NEGATIVE (error-path) API regression test for the Medusa v2
e-commerce backend. A status-code assertion already exists for every step. Your job:
propose BEHAVIORAL INVARIANTS over the FAILURE response body that prove the request
was rejected FOR THE RIGHT REASON — not merely that some non-2xx came back.

Flow: ${candidate.flow_name}
Persona: ${candidate.persona}
Steps (use the exact step title verbatim as "stepTitle"):
${steps}${context}

Rules:
- Propose invariants on the steps whose expected status is a 4xx/5xx — assert the
  ERROR body's shape (e.g. an error "type"/"code", a non-empty "message").
- Only propose an invariant you are confident holds on the error response. When unsure, omit it.
- One invariant = one assertion over one path in that step's response body.
- "path" is a dotted path into the JSON body (e.g. "type", "message", "code").
${MATCHER_LINE}
- You may use an approved template when it fits the response body. For templates,
  "path" points to the object the template checks, e.g. "cart", "order", or "" for
  the whole response.
- Prefer invariants that catch a CONTRACT drift in the failure (the right error code/type),
  not just "it failed". Use the custom auth gate above to know WHY a step is blocked.

${OUTPUT_LINE}`;
  }

  return `You are auditing an API regression test for the Medusa v2 e-commerce backend.
A status-code assertion already exists for every step. Your job: propose BEHAVIORAL
INVARIANTS over the RESPONSE BODY that a status code alone cannot prove.

Flow: ${candidate.flow_name}
Persona: ${candidate.persona}
Steps (use the exact step title verbatim as "stepTitle"):
${steps}${context}

Rules:
- Only propose an invariant you are confident holds on a SUCCESSFUL run. When unsure, omit it.
- One invariant = one assertion over one path in that step's response body.
- "path" is a dotted path into the JSON body (e.g. "order.payment_status", "cart.items.length").
  A trailing ".length" is allowed on arrays.
${MATCHER_LINE}
- You may use an approved template when it fits the response body. For templates,
  "path" points to the object the template checks, e.g. "cart", "order", or "" for
  the whole response.
- Prefer invariants that catch silent behavioral regressions (e.g. a cart that returns 200
  but did NOT convert to an order: assert body "type" toBe "order"). The endpoint-behavior
  notes above (side effects, success discriminator) are your best source for these.

${OUTPUT_LINE}`;
}

/** The per-flow template-cache key (cache #2). A hash over every input that
 * shapes the agent's proposal: prompt version, flow identity, the OAS response
 * shape per step, the gate-contract source, and each step's behavior digest. The
 * CLI re-invokes the agent only when this changes — a workflow code change flows
 * through to a regenerated digest, which changes this key, which triggers a
 * re-proposal exactly when (and only when) the underlying behavior changed. */
export function flowCacheKey(candidate: Candidate, specs: OasSpecs, ctx: ProposalContext): string {
  const stepParts = candidate.steps.map((s) => {
    const title = stepTitle(s.method, s.endpoint);
    const hint = responseFieldHint(specs, s.method, s.endpoint, s.expected_status).join(",");
    const digest = ctx.digestByStep.get(title) ?? "";
    return `${title}|${s.expected_status}|${hint}|${sha256(digest)}`;
  });
  return sha256(
    [PROMPT_VERSION, candidate.signature, sha256(ctx.gateContract ?? ""), ...stepParts].join("\n")
  );
}

/** Strip an optional ```json fence the model may add despite instructions. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Parse the agent's response into VALID invariants, stamped `source: "ai-proposed"`
 * and `verified: false` (verification is a separate gate — types.ts). Malformed
 * entries (bad matcher, missing argument, non-array output) are dropped, never
 * thrown: a garbage completion yields zero invariants, not a crashed run.
 */
export function parseInvariantResponse(
  text: string,
  polarity: "success" | "error" = "success"
): Invariant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Invariant[] = [];
  for (const raw of parsed) {
    const candidate = {
      ...(raw as object),
      source: "ai-proposed" as const,
      polarity,
      verified: false,
    };
    if (isValidInvariant(candidate)) out.push(candidate);
  }
  return out;
}
