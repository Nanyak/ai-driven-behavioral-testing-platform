/**
 * Persona resolution — emergent, deterministic, from attributes only.
 *
 * Resolution table (plan §Emergent persona derivation), highest-privilege wins
 * for a session that changes role mid-stream:
 *
 *   is_admin                         -> admin_operator
 *   requires_auth and not is_admin   -> registered_customer
 *   neither                          -> guest_shopper
 *
 * `has_errors` is an ORTHOGONAL overlay (an edge-case flag), never a competing
 * persona. Persona is always tagged `persona_source: "emergent_attributes"`.
 */

import type { AttrStep, FlowAttributes } from "./attributes.js";
import { deriveAttributes } from "./attributes.js";

export type Persona = "admin_operator" | "registered_customer" | "guest_shopper";

/** The three non-error personas, in privilege order (used for per-persona gates). */
export const PERSONAS: readonly Persona[] = [
  "guest_shopper",
  "registered_customer",
  "admin_operator",
];

export const PERSONA_SOURCE = "emergent_attributes" as const;

/** Resolve persona from already-derived attributes (highest privilege wins). */
export function resolvePersona(attrs: FlowAttributes): Persona {
  if (attrs.is_admin) {
    return "admin_operator";
  }
  if (attrs.requires_auth) {
    return "registered_customer";
  }
  return "guest_shopper";
}

export interface Classification {
  attributes: FlowAttributes;
  persona: Persona;
}

/** Convenience: derive attributes (under a rule variant) then resolve persona. */
export function classify(steps: AttrStep[], useCartSignal: boolean): Classification {
  const attributes = deriveAttributes(steps, useCartSignal);
  return { attributes, persona: resolvePersona(attributes) };
}
