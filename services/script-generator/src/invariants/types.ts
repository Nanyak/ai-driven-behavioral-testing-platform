/**
 * Behavioral-invariant layer (status-code is not enough).
 *
 * A status assertion proves "the server didn't reject the request". It cannot
 * prove the BEHAVIOR held: a `POST /store/carts/{id}/complete` returns 200 even
 * when the cart fails to convert (Medusa v2 answers 200 with `{ type: "cart",
 * error }` instead of `{ type: "order", order }`). An invariant is a per-step
 * assertion over the RESPONSE BODY that captures that behavior.
 *
 * Provenance & trust (the anti-hallucination contract):
 *   - `source: "ai-proposed"` invariants come from an LLM reading the flow + OAS.
 *   - `source: "deterministic"` invariants come from hard-coded endpoint
 *     contracts whose response shape is stable in this repo (see
 *     deterministic.ts).
 *     The LLM only ever PROPOSES a structured invariant — it never writes test
 *     code and never touches the status oracle (see oracle-guard.ts).
 *   - An invariant is rendered into a spec ONLY when `verified === true`: it was
 *     checked once against the live, known-good backend and HELD. An unverified
 *     (or failed-verification) invariant is dropped, never baked — so a wrong AI
 *     guess can never enter the regression suite and silently bless a bug.
 *
 * The artifact is keyed by `flow_signature` (ADR 0002) so it survives
 * regeneration the same way candidates do: emit reads the verified invariants
 * for a flow and renders them deterministically. No LLM call happens at generate
 * time — generation stays deterministic and offline-runnable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
export const INVARIANTS_ARTIFACT = resolvePath(REPO_ROOT, "data", "invariants", "invariants.json");

/**
 * Matchers an invariant may use. Deliberately a small, closed set — each maps to
 * exactly one Playwright `expect(...)` call (see render.ts), so the rendered
 * assertion is fully deterministic and the LLM cannot smuggle arbitrary code.
 */
export type InvariantMatcher =
  | "toBe"
  | "toEqual"
  | "toBeGreaterThan"
  | "toBeGreaterThanOrEqual"
  | "toBeLessThan"
  | "toBeLessThanOrEqual"
  | "toBeTruthy"
  | "toBeDefined"
  | "toBeUndefined"
  | "toContain";

const MATCHERS: ReadonlySet<string> = new Set<InvariantMatcher>([
  "toBe",
  "toEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeTruthy",
  "toBeDefined",
  "toBeUndefined",
  "toContain",
]);

/** Matchers that take NO argument (assert presence/truthiness only). */
export const NULLARY_MATCHERS: ReadonlySet<InvariantMatcher> = new Set<InvariantMatcher>([
  "toBeTruthy",
  "toBeDefined",
  "toBeUndefined",
]);

export const APPROVED_TEMPLATE_NAMES = [
  "auth_success_token",
  "auth_failure_error",
  "cart_totals_balance",
  "cart_has_items",
  "invalid_promotion_not_applied",
  "checkout_returns_order",
  "order_totals_balance",
  "admin_order_canceled",
] as const;

export type ApprovedTemplateName = (typeof APPROVED_TEMPLATE_NAMES)[number];

export function isApprovedTemplateName(value: unknown): value is ApprovedTemplateName {
  return typeof value === "string" && (APPROVED_TEMPLATE_NAMES as readonly string[]).includes(value);
}

interface BaseInvariant {
  /** The emitted step title this attaches to, e.g. "POST /store/carts/{id}/complete". */
  stepTitle: string;
  /** One-line behavioral rationale — emitted as the assertion label so a failure reads clearly. */
  rationale: string;
  source: "ai-proposed" | "deterministic";
  /** Which body this asserts over: a successful response ("success", default) or
   * a failure/error response ("error"). Metadata for auditing + the demo; render
   * and evaluate are polarity-agnostic. Absent is treated as "success". */
  polarity?: "success" | "error";
  /** True once the invariant held against the live known-good backend. ONLY verified invariants render. */
  verified: boolean;
}

export interface FieldInvariant extends BaseInvariant {
  kind?: "field";
  /** Dotted path into the JSON response body, e.g. "order.payment_status" or "cart.items.length". */
  path: string;
  matcher: InvariantMatcher;
  /** Expected value; omitted for nullary matchers (toBeTruthy/toBeDefined). */
  expected?: string | number | boolean;
}

export interface TemplateInvariant extends BaseInvariant {
  kind: "template";
  template: ApprovedTemplateName;
  /** Dotted path to the object the template asserts over. Empty string means the full response body. */
  path: string;
}

export interface DraftTemplateProposal {
  kind: "draft_template";
  name: string;
  stepTitle: string;
  intent: string;
  rationale: string;
  evidence?: string[];
  source: "ai-proposed";
  status: "needs_review";
}

export type Invariant = FieldInvariant | TemplateInvariant;

export function isTemplateInvariant(value: Invariant): value is TemplateInvariant {
  return value.kind === "template";
}

export function isFieldInvariant(value: Invariant): value is FieldInvariant {
  return value.kind === undefined || value.kind === "field";
}

export interface FlowInvariants {
  flow_name: string;
  invariants: Invariant[];
  /** Per-flow template-cache key (cache #2): a hash over the prompt inputs
   * (flow signature + endpoint source/digest + OAS shape + prompt version). The
   * proposal agent is re-invoked only when this changes — so the LLM rides the
   * AUTHORING path, not the generate path. Absent on legacy/seeded flows. */
  cache_key?: string;
  /** When the agent last proposed for this flow (a real ISO timestamp is the
   * honest signal that an agent run — not hand-seeding — produced this). */
  proposed_at?: string;
}

export interface InvariantsArtifact {
  generated_at: string;
  /** Keyed by flow_signature (full 64-char hash). */
  flows: Record<string, FlowInvariants>;
}

/** A single invariant is well-formed: known matcher, non-empty path/step, and an
 * `expected` present exactly when the matcher needs one. A malformed entry (e.g.
 * a hallucinated matcher or a missing argument) is rejected, never rendered. */
export function isValidInvariant(value: unknown): value is Invariant {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.stepTitle !== "string" || v.stepTitle.length === 0) return false;
  if (typeof v.rationale !== "string" || v.rationale.length === 0) return false;
  if (v.source !== "ai-proposed" && v.source !== "deterministic") return false;
  if (typeof v.verified !== "boolean") return false;
  if ("polarity" in v && v.polarity !== undefined && v.polarity !== "success" && v.polarity !== "error") {
    return false;
  }

  if (v.kind === "template") {
    return isApprovedTemplateName(v.template) && typeof v.path === "string";
  }

  if (v.kind !== undefined && v.kind !== "field") return false;
  if (typeof v.path !== "string" || v.path.length === 0) return false;
  if (typeof v.matcher !== "string" || !MATCHERS.has(v.matcher)) return false;
  const nullary = NULLARY_MATCHERS.has(v.matcher as InvariantMatcher);
  if (nullary) {
    if ("expected" in v && v.expected !== undefined) return false;
  } else {
    const t = typeof v.expected;
    if (t !== "string" && t !== "number" && t !== "boolean") return false;
  }
  return true;
}

const EMPTY_ARTIFACT: InvariantsArtifact = { generated_at: "", flows: {} };

/** Load the invariants artifact, or an empty one when absent/malformed (never throws). */
export function loadInvariants(path: string = INVARIANTS_ARTIFACT): InvariantsArtifact {
  if (!existsSync(path)) return EMPTY_ARTIFACT;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as InvariantsArtifact;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.flows !== "object") {
      return EMPTY_ARTIFACT;
    }
    return parsed;
  } catch {
    return EMPTY_ARTIFACT;
  }
}

export function saveInvariants(artifact: InvariantsArtifact, path: string = INVARIANTS_ARTIFACT): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

/**
 * The VERIFIED invariants for a flow, grouped by step title — exactly what emit
 * renders. Unverified or malformed entries are filtered out here, so emit never
 * has to know about the trust contract. An unknown signature yields an empty map.
 */
export function verifiedInvariantsByStep(
  artifact: InvariantsArtifact,
  flowSignature: string
): Map<string, Invariant[]> {
  const byStep = new Map<string, Invariant[]>();
  const flow = artifact.flows[flowSignature];
  if (!flow) return byStep;
  for (const inv of flow.invariants) {
    if (!inv.verified || !isValidInvariant(inv)) continue;
    const list = byStep.get(inv.stepTitle) ?? [];
    list.push(inv);
    byStep.set(inv.stepTitle, list);
  }
  return byStep;
}
