// Resolves against the AUGMENTED Store/Admin OpenAPI spec (`openapi/augmented/`,
// written by `build-oas.ts`) — the authoritative skeleton for spec-sourced
// goldens (ADR 0001/0004). If the augmented spec has no entry for the
// operation/status, callers fall back to `schema_source: "observed"`.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRefResponse,
  isRefSchema,
  type OasDocument,
  type OasInlineResponse,
  type OasInlineSchema,
  type OasMethod,
  type OasSchema,
} from "./oas-types.js";
import type { SchemaNode, ValueRule } from "../types.js";
import { extractValueRules } from "../value/value-rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const AUGMENTED_DIR = resolvePath(__dirname, "..", "..", "openapi", "augmented");

export interface OasResolution {
  schema: SchemaNode;
  operationId: string;
  ref: string | null;
  oasVersion: string;
  /** Spec-authored value invariants for this response (Tier A). */
  valueRules: ValueRule[];
}

function loadJson(path: string): OasDocument {
  return JSON.parse(readFileSync(path, "utf8")) as OasDocument;
}

export function loadAugmentedSpecs(
  dir: string = AUGMENTED_DIR
): Record<"store" | "admin", OasDocument> {
  return {
    store: loadJson(resolvePath(dir, "store.json")),
    admin: loadJson(resolvePath(dir, "admin.json")),
  };
}

// Used as `oas_version` fallback when the spec doesn't declare info.version.
export function oasContentHash(doc: OasDocument): string {
  return createHash("sha256").update(stableStringify(doc)).digest("hex").slice(0, 16);
}

// Sorted keys so the same document always hashes/serializes identically.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      sorted[key] = sortKeysDeep(child);
    }
    return sorted;
  }
  return value;
}

/**
 * Resolve a `$ref` against either `components/schemas` or `components/responses`
 * (the real bundled Medusa spec uses both — e.g. shared error envelopes live
 * under `components/responses/*`, $ref'd by status from many operations).
 */
function resolveRef(doc: OasDocument, ref: string): OasInlineSchema {
  const schemaMatch = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (schemaMatch) {
    const schema = doc.components.schemas[schemaMatch[1]];
    if (!schema) throw new Error(`$ref does not resolve: ${ref}`);
    return schema;
  }
  const responseMatch = /^#\/components\/responses\/(.+)$/.exec(ref);
  if (responseMatch) {
    const response = doc.components.responses?.[responseMatch[1]];
    if (!response) throw new Error(`$ref does not resolve: ${ref}`);
    const mediaType = response.content?.["application/json"] ?? firstMediaType(response.content);
    if (!mediaType) throw new Error(`$ref response has no usable media type: ${ref}`);
    return isRefSchema(mediaType.schema) ? resolveRef(doc, mediaType.schema.$ref) : mediaType.schema;
  }
  throw new Error(`Unsupported $ref (not a local component schema/response): ${ref}`);
}

function firstMediaType(
  content: Record<string, { schema: OasSchema }> | undefined
): { schema: OasSchema } | undefined {
  if (!content) return undefined;
  const key = Object.keys(content)[0];
  return key ? content[key] : undefined;
}

function resolveResponseRef(
  doc: OasDocument,
  response: { $ref: string } | OasInlineResponse
): OasInlineResponse {
  if (!isRefResponse(response)) return response;
  const match = /^#\/components\/responses\/(.+)$/.exec(response.$ref);
  if (!match) throw new Error(`Unsupported response $ref: ${response.$ref}`);
  const resolved = doc.components.responses?.[match[1]];
  if (!resolved) throw new Error(`Response $ref does not resolve: ${response.$ref}`);
  return resolved;
}

/**
 * A property is OPTIONAL when its parent's `required` array omits it, and
 * NULLABLE when it declares `nullable: true` or a `"null"` member in its `type`
 * union. The flat SchemaNode model can express neither "may be absent" nor "may
 * be null", so for an optional-OR-nullable field we emit `"ignored"` — compare.ts
 * skips an `"ignored"` field in BOTH directions, so a spec-conformant response
 * that legitimately omits the field (optional) or sends `null` (nullable) no
 * longer reads as `missing_field`/`type_changed` drift. Only REQUIRED +
 * NON-NULLABLE fields are asserted, making the derived oracle exactly as strict
 * as the spec declares — never stricter. (The old flatten promoted every
 * property to required and dropped nullability, a top cause of false OAS drift;
 * see the 2026-06-27 OAS-drift investigation.)
 */
function isNullable(schema: OasSchema): boolean {
  if (isRefSchema(schema)) return false; // OAS 3.0: a bare $ref cannot carry `nullable`
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  return schema.nullable === true;
}

function primitiveLeaf(type: string | undefined): SchemaNode {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function flatten(doc: OasDocument, schema: OasSchema): SchemaNode {
  if (isRefSchema(schema)) {
    return flatten(doc, resolveRef(doc, schema.$ref));
  }
  if (schema.oneOf) {
    // Exactly-one-of: only fields common to EVERY branch are guaranteed present;
    // a field unique to some branches is conditionally present, so it becomes
    // "ignored" rather than demanding the union of all mutually-exclusive shapes.
    return unionOneOf(schema.oneOf.map((branch) => flatten(doc, branch)));
  }
  if (schema.allOf) {
    // Composition (AND): the value satisfies every fragment. Merge fragment
    // shapes, preferring a concrete type over "ignored" — a field required by
    // any fragment is required overall.
    return schema.allOf
      .map((branch) => flatten(doc, branch))
      .reduce((acc, node) => mergeAllOf(acc, node));
  }
  const typeList = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (typeList.includes("array")) {
    return "array";
  }
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    const node: { [key: string]: SchemaNode } = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      node[key] = required.has(key) && !isNullable(child) ? flatten(doc, child) : "ignored";
    }
    return node;
  }
  return primitiveLeaf(typeList.find((t) => t !== "null"));
}

/**
 * Merge two flattened `oneOf` branches: keep only keys present in EVERY object
 * branch (recursively merged); keys unique to some branches are optional across
 * variants and become "ignored". Mixed object/leaf branches keep the object
 * shape (more structural information), matching the prior union rule.
 */
function unionOneOf(branches: SchemaNode[]): SchemaNode {
  const objs = branches.filter(
    (b): b is { [k: string]: SchemaNode } => typeof b === "object"
  );
  if (objs.length === 0) return branches[0];
  const allKeys = new Set(objs.flatMap((o) => Object.keys(o)));
  const out: { [k: string]: SchemaNode } = {};
  for (const key of allKeys) {
    out[key] = objs.every((o) => key in o)
      ? objs.map((o) => o[key]).reduce((a, b) => mergeSame(a, b))
      : "ignored";
  }
  return out;
}

/**
 * Merge two flattened `allOf` fragments. Two objects merge their keys; a
 * concrete type wins over "ignored"; an object wins over a bare leaf (more
 * structural information); conflicting leaves collapse to "ignored".
 */
function mergeAllOf(a: SchemaNode, b: SchemaNode): SchemaNode {
  if (typeof a === "object" && typeof b === "object") {
    const out: { [k: string]: SchemaNode } = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = k in out ? mergeSame(out[k], v) : v;
    }
    return out;
  }
  return mergeSame(a, b);
}

/** Merge two nodes for the SAME key/path (helper for union/allOf). */
function mergeSame(a: SchemaNode, b: SchemaNode): SchemaNode {
  if (a === "ignored") return b;
  if (b === "ignored") return a;
  if (typeof a === "object" && typeof b === "object") return mergeAllOf(a, b);
  if (typeof a === "object") return a;
  if (typeof b === "object") return b;
  return a === b ? a : "ignored";
}

/**
 * Locate the response's `$ref` string for provenance — the TOP-LEVEL `$ref`
 * the response's `application/json` schema points to (e.g.
 * `#/components/schemas/StoreCartResponse`, the wrapper — not the nested
 * `StoreCart` it wraps one property down). `oas-source.ts`'s job is to
 * resolve the wrapper into a flat shape for comparison (`flatten` above);
 * `oas_ref` provenance stays at the wrapper so an auditor can trace the
 * golden back to the exact response schema the operation documents.
 * `null` for inline/oneOf/allOf responses with no single top-level ref.
 */
function findRef(schema: OasSchema): string | null {
  if (isRefSchema(schema)) return schema.$ref;
  return null;
}

export function resolveFromDoc(
  doc: OasDocument,
  method: string,
  endpoint: string,
  status: number
): OasResolution | null {
  const pathItem = doc.paths[endpoint];
  if (!pathItem) return null;
  const operation = pathItem[method.toLowerCase() as OasMethod];
  if (!operation) return null;
  const rawResponse = operation.responses[String(status)];
  if (!rawResponse) return null;
  const response = resolveResponseRef(doc, rawResponse);

  const mediaType = response.content?.["application/json"];
  if (!mediaType) return null;

  return {
    schema: flatten(doc, mediaType.schema),
    operationId: operation.operationId,
    ref: findRef(mediaType.schema),
    oasVersion: doc.info.version || oasContentHash(doc),
    valueRules: extractValueRules(doc, mediaType.schema),
  };
}

// Tries Store first, then Admin — the two path namespaces never collide in
// practice (`/store/*` vs `/admin/*`).
export function resolveOperation(
  specs: Record<"store" | "admin", OasDocument>,
  method: string,
  endpoint: string,
  status: number
): OasResolution | null {
  return (
    resolveFromDoc(specs.store, method, endpoint, status) ??
    resolveFromDoc(specs.admin, method, endpoint, status)
  );
}
