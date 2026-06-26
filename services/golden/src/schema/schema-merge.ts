/**
 * `tightenWithObserved`: the spec is authoritative on field EXISTENCE; an
 * under-specified spec leaf (e.g. `"object"` for `metadata`) is narrowed by
 * a more specific observed shape for the SAME field. Fields the spec
 * declares are never removed by observation.
 *
 * `unionSchema`: union of keys across two schemas of the same shape — used
 * (a) to merge observed schemas across multiple sessions of the same
 * endpoint, so optional fields are captured rather than treated as
 * regressions, and (b) by `build-oas.ts` for the ADR 0004 `oneOf` collision
 * union. Type conflicts on the same key are recorded, not silently dropped.
 */
import { isObjectNode } from "./schema-extract.js";
import {
  GLOBAL_IGNORE_FIELDS,
  PER_ENDPOINT_IGNORE_FIELDS,
  ignoreFieldsFor,
} from "../ignore-fields.js";
import { filterIgnoredValueRules } from "../value/value-rules.js";
import type { OasResolution } from "../oas/oas-source.js";
import type { GoldenResponse, SchemaNode, SchemaSource } from "../types.js";

export interface TypeConflict {
  path: string;
  a: SchemaNode;
  b: SchemaNode;
}

export interface MergeResult {
  schema: SchemaNode;
  conflicts: TypeConflict[];
}

function isLeaf(node: SchemaNode): node is Exclude<SchemaNode, { [key: string]: SchemaNode }> {
  return !isObjectNode(node);
}

/**
 * Tighten an OAS skeleton field with an observed schema for the same field.
 * Spec is authoritative on existence: keys present only in `oasNode` are kept
 * as-is. Keys present in both are narrowed when the observed node is strictly
 * more specific (object vs a generic leaf, or both objects — recurse).
 */
export function tightenWithObserved(oasNode: SchemaNode, observedNode: SchemaNode): SchemaNode {
  if (isObjectNode(oasNode) && isObjectNode(observedNode)) {
    const tightened: { [key: string]: SchemaNode } = {};
    for (const [key, oasChild] of Object.entries(oasNode)) {
      tightened[key] =
        key in observedNode ? tightenWithObserved(oasChild, observedNode[key]) : oasChild;
    }
    return tightened;
  }
  if (isObjectNode(observedNode) && isLeaf(oasNode)) {
    // Spec declared a generic leaf (e.g. "object"/"array") for this field;
    // observation supplies real field-level typing — narrow to it.
    if (oasNode === "object" || oasNode === "array") {
      return observedNode;
    }
    return oasNode;
  }
  if (isLeaf(oasNode) && isLeaf(observedNode)) {
    // Spec leaf stands; it is authoritative on type. "ignored" from
    // observation still wins so dynamic fields stay excluded from compare.
    return observedNode === "ignored" ? "ignored" : oasNode;
  }
  return oasNode;
}

/**
 * Union two schemas of (expected) equal shape: merge object keys, recursing
 * into shared keys, keeping keys unique to either side. Leaf/leaf conflicts
 * of different types are recorded in `conflicts` and resolved by keeping `a`
 * (deterministic — no LLM, ADR 0004 decision #4) with the conflict surfaced
 * for human review.
 */
export function unionSchema(a: SchemaNode, b: SchemaNode, path = ""): MergeResult {
  const conflicts: TypeConflict[] = [];

  function merge(nodeA: SchemaNode, nodeB: SchemaNode, currentPath: string): SchemaNode {
    if (isObjectNode(nodeA) && isObjectNode(nodeB)) {
      const merged: { [key: string]: SchemaNode } = { ...nodeA };
      for (const [key, childB] of Object.entries(nodeB)) {
        const childPath = currentPath ? `${currentPath}.${key}` : key;
        merged[key] = key in merged ? merge(merged[key], childB, childPath) : childB;
      }
      return merged;
    }
    if (isLeaf(nodeA) && isLeaf(nodeB)) {
      if (nodeA === nodeB) return nodeA;
      if (nodeA === "null") return nodeB;
      if (nodeB === "null") return nodeA;
      if (nodeA === "ignored" || nodeB === "ignored") return "ignored";
      conflicts.push({ path: currentPath, a: nodeA, b: nodeB });
      return nodeA;
    }
    // Shape mismatch (object vs leaf): deterministic — keep the object shape
    // since it carries more structural information; record the conflict.
    conflicts.push({ path: currentPath, a: nodeA, b: nodeB });
    return isObjectNode(nodeA) ? nodeA : nodeB;
  }

  const schema = merge(a, b, path);
  return { schema, conflicts };
}

/**
 * Build a `GoldenResponse` for one `(endpoint, status)`, stamping
 * `schema_source` and OAS provenance (step 3: intersect + merge):
 *
 *  - OAS entry + observed schema  -> intersect/tighten, `"openapi+observed"`.
 *  - OAS entry, no observed data  -> spec skeleton as-is, `"openapi"` (bodies
 *    off, or no session hit this op yet — still a valid oracle, ADR 0001).
 *  - No OAS entry                 -> observed schema only, `"observed"`,
 *    provenance fields `null`.
 *
 * `expected_status`: spec-sourced when an OAS resolution exists (happy-path
 * or overlay-documented error, ADR 0004); otherwise the observed status.
 */
const GLOBAL_IGNORE_SET = new Set<string>(GLOBAL_IGNORE_FIELDS);

/**
 * Stamp the ignore-field policy onto an OAS-derived expected schema so it is
 * SYMMETRIC with the observed half (`schema-extract.ts` `describeAt`): any field
 * whose name is globally ignored (at ANY depth) or whose dotted path is a
 * per-endpoint ignore becomes `"ignored"`. Without this, a pure-`openapi`
 * golden over-asserts on dynamic fields (`id`, `*.created_at`, …) that the
 * observed side strips, producing false `missing_field` diffs. Idempotent on an
 * already-marked (observed/merged) schema. Mirrors `extractObservedSchema`.
 */
function applyIgnorePolicy(node: SchemaNode, endpoint: string, path = ""): SchemaNode {
  if (!isObjectNode(node)) return node;
  const perEndpoint = new Set(PER_ENDPOINT_IGNORE_FIELDS[endpoint] ?? []);
  const out: { [key: string]: SchemaNode } = {};
  for (const [key, child] of Object.entries(node)) {
    const childPath = path ? `${path}.${key}` : key;
    out[key] =
      GLOBAL_IGNORE_SET.has(key) || perEndpoint.has(childPath)
        ? "ignored"
        : applyIgnorePolicy(child, endpoint, childPath);
  }
  return out;
}

export function buildGolden(params: {
  endpoint: string;
  observedStatus: number;
  observedSchema: SchemaNode | null;
  oas: OasResolution | null;
  capturedAt: string;
  sourceSessions: string[];
}): GoldenResponse {
  const { endpoint, observedStatus, observedSchema, oas, capturedAt, sourceSessions } = params;

  let schema: SchemaNode;
  let schemaSource: SchemaSource;
  let expectedStatus: number;

  if (oas && observedSchema) {
    schema = tightenWithObserved(oas.schema, observedSchema);
    schemaSource = "openapi+observed";
    expectedStatus = observedStatus;
  } else if (oas) {
    schema = oas.schema;
    schemaSource = "openapi";
    expectedStatus = observedStatus;
  } else if (observedSchema) {
    schema = observedSchema;
    schemaSource = "observed";
    expectedStatus = observedStatus;
  } else {
    throw new Error(`buildGolden: neither an OAS resolution nor an observed schema for ${endpoint}`);
  }

  return {
    endpoint,
    expected_status: expectedStatus,
    expected_schema: applyIgnorePolicy(schema, endpoint),
    ignore_fields: ignoreFieldsFor(endpoint),
    schema_source: schemaSource,
    oas_operation_id: oas?.operationId ?? null,
    oas_ref: oas?.ref ?? null,
    oas_version: oas?.oasVersion ?? null,
    // Tier A: lift spec-authored value constraints, minus any that land on an
    // ignored field (kept consistent with the type layer).
    value_rules: oas ? filterIgnoredValueRules(oas.valueRules, endpoint) : [],
    captured_at: capturedAt,
    source_sessions: sourceSessions,
  };
}
