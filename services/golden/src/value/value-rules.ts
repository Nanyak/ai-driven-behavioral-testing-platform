/**
 * Tier A value-level golden (ADR 0001).
 *
 * THREE pure functions, no LLM, no network:
 *   - `extractValueRules`  — lift `enum`/`const`/`minimum`/`maximum`/`format`
 *     constraints OUT of an OpenAPI response schema into flat, path-addressed
 *     `ValueRule`s. The spec is the author, so this is deterministic.
 *   - `filterIgnoredValueRules` — drop rules whose path lands on an ignored
 *     field, so the value layer never asserts what the type layer ignores.
 *   - `evaluateValueRules` — check a live response body against the rules,
 *     returning a (possibly empty) list of violations.
 *
 * SOUNDNESS RULES (why this never produces false reds):
 *   - `oneOf` subtrees are SKIPPED entirely. A value that only holds in one
 *     alternative branch cannot be asserted when the response may legally match
 *     another branch. `allOf` branches ARE descended (all constraints apply).
 *   - A rule NEVER fires on an absent or `null` value (existence/nullability is
 *     the schema layer's job — keeps the two layers orthogonal).
 *   - `format`/`range` skip values of the wrong JSON type (a non-string for a
 *     `format`, a non-number for a `range`) — that mismatch is the type layer's
 *     to report, not this one's.
 *   - The same `(path, kind)` reached via two branches with CONFLICTING content
 *     (e.g. two different enums) is dropped, not guessed.
 */
import {
  isRefSchema,
  type OasDocument,
  type OasInlineSchema,
  type OasSchema,
} from "../oas/oas-types.js";
import { GLOBAL_IGNORE_FIELDS, PER_ENDPOINT_IGNORE_FIELDS } from "../ignore-fields.js";
import type { ValueFormat, ValueRule } from "../types.js";

const SUPPORTED_FORMATS = new Set<ValueFormat>(["uuid", "email", "date-time"]);
const GLOBAL_IGNORE_SET = new Set<string>(GLOBAL_IGNORE_FIELDS);
const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Extraction (OAS schema -> ValueRule[])
// ---------------------------------------------------------------------------

function resolveSchemaRef(doc: OasDocument, ref: string): OasInlineSchema | null {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) return null; // response-level refs never appear inside a schema tree
  return doc.components.schemas[match[1]] ?? null;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Emit the leaf-level constraints declared directly on `schema` at `path`. */
function emitLeafRules(schema: OasInlineSchema, path: string, add: (rule: ValueRule) => void): void {
  if (!path) return; // a rule needs a field path; root scalars never occur in practice

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(isScalar);
    if (values.length > 0) add({ path, kind: "enum", values });
  } else if (isScalar(schema.const)) {
    add({ path, kind: "const", value: schema.const });
  }

  if (typeof schema.minimum === "number" || typeof schema.maximum === "number") {
    add({
      path,
      kind: "range",
      ...(typeof schema.minimum === "number" ? { min: schema.minimum } : {}),
      ...(typeof schema.maximum === "number" ? { max: schema.maximum } : {}),
    });
  }

  if (typeof schema.format === "string" && SUPPORTED_FORMATS.has(schema.format as ValueFormat)) {
    add({ path, kind: "format", format: schema.format as ValueFormat });
  }
}

/**
 * Walk an OAS response schema, collecting value rules. `visitedRefs` guards
 * against recursive `$ref` cycles (Medusa schemas self-reference, e.g.
 * product -> variants -> product); `depth` bounds traversal independently.
 */
export function extractValueRules(doc: OasDocument, root: OasSchema): ValueRule[] {
  // Keyed by `${path}::${kind}`. Value `null` marks a recorded conflict (drop).
  const collected = new Map<string, ValueRule | null>();

  const add = (rule: ValueRule): void => {
    const key = `${rule.path}::${rule.kind}`;
    if (!collected.has(key)) {
      collected.set(key, rule);
      return;
    }
    const existing = collected.get(key);
    if (existing === null) return; // already a conflict
    if (JSON.stringify(existing) !== JSON.stringify(rule)) {
      collected.set(key, null); // conflicting content for same (path, kind) -> drop
    }
  };

  const walk = (schema: OasSchema, path: string, depth: number, visitedRefs: Set<string>): void => {
    if (depth > MAX_DEPTH) return;

    if (isRefSchema(schema)) {
      if (visitedRefs.has(schema.$ref)) return; // cycle
      const resolved = resolveSchemaRef(doc, schema.$ref);
      if (!resolved) return;
      walk(resolved, path, depth, new Set([...visitedRefs, schema.$ref]));
      return;
    }

    // oneOf alternatives are not soundly assertable at value level.
    if (schema.oneOf) return;
    if (schema.allOf) {
      for (const branch of schema.allOf) walk(branch, path, depth + 1, visitedRefs);
      return;
    }

    emitLeafRules(schema, path, add);

    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1, visitedRefs);
      }
    }
    if (schema.items) {
      walk(schema.items, `${path}[]`, depth + 1, visitedRefs);
    }
  };

  walk(root, "", 0, new Set());

  return [...collected.values()]
    .filter((rule): rule is ValueRule => rule !== null)
    .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Ignore-field filtering (keep value layer consistent with the type layer)
// ---------------------------------------------------------------------------

/** Strip `[]` markers, returning the dotted field path and its segments. */
function dottedPath(rulePath: string): { dotted: string; segments: string[] } {
  const segments = rulePath.split(".").map((seg) => (seg.endsWith("[]") ? seg.slice(0, -2) : seg));
  return { dotted: segments.join("."), segments };
}

export function filterIgnoredValueRules(rules: ValueRule[], endpoint: string): ValueRule[] {
  const perEndpoint = new Set(PER_ENDPOINT_IGNORE_FIELDS[endpoint] ?? []);
  return rules.filter((rule) => {
    const { dotted, segments } = dottedPath(rule.path);
    if (perEndpoint.has(dotted)) return false;
    return !segments.some((seg) => GLOBAL_IGNORE_SET.has(seg));
  });
}

// ---------------------------------------------------------------------------
// Evaluation (ValueRule[] vs live body)
// ---------------------------------------------------------------------------

export interface ValueDiffEntry {
  kind: ValueRule["kind"];
  /** The rule path (with `[]` for arrays); the constraint that was violated. */
  path: string;
  /** Human-readable description of the expected constraint. */
  expected: string;
  /** The offending live value. */
  actual: unknown;
}

const FORMAT_PATTERNS: Record<ValueFormat, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
};

/** Resolve a dotted/`[]` path against a body, returning every addressed value. */
function resolvePathValues(body: unknown, rulePath: string): unknown[] {
  let frontier: unknown[] = [body];
  for (const seg of rulePath.split(".")) {
    const isArray = seg.endsWith("[]");
    const key = isArray ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const node of frontier) {
      if (node === null || typeof node !== "object") continue;
      const value = (node as Record<string, unknown>)[key];
      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    frontier = next;
  }
  return frontier;
}

function violation(rule: ValueRule, value: unknown): ValueDiffEntry | null {
  switch (rule.kind) {
    case "enum":
      return rule.values.includes(value as string | number | boolean)
        ? null
        : { kind: "enum", path: rule.path, expected: `one of ${JSON.stringify(rule.values)}`, actual: value };
    case "const":
      return value === rule.value
        ? null
        : { kind: "const", path: rule.path, expected: JSON.stringify(rule.value), actual: value };
    case "range": {
      if (typeof value !== "number") return null; // wrong type -> schema layer's job
      const belowMin = rule.min !== undefined && value < rule.min;
      const aboveMax = rule.max !== undefined && value > rule.max;
      if (!belowMin && !aboveMax) return null;
      const bounds = `${rule.min ?? "-inf"}..${rule.max ?? "+inf"}`;
      return { kind: "range", path: rule.path, expected: `within ${bounds}`, actual: value };
    }
    case "format":
      if (typeof value !== "string") return null; // wrong type -> schema layer's job
      return FORMAT_PATTERNS[rule.format].test(value)
        ? null
        : { kind: "format", path: rule.path, expected: `format ${rule.format}`, actual: value };
  }
}

export function evaluateValueRules(rules: ValueRule[], body: unknown): ValueDiffEntry[] {
  const diffs: ValueDiffEntry[] = [];
  for (const rule of rules) {
    for (const value of resolvePathValues(body, rule.path)) {
      if (value === undefined || value === null) continue; // absent/null -> never fires
      const diff = violation(rule, value);
      if (diff) diffs.push(diff);
    }
  }
  return diffs;
}
