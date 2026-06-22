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
import type { SchemaNode } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const AUGMENTED_DIR = resolvePath(__dirname, "..", "openapi", "augmented");

export interface OasResolution {
  schema: SchemaNode;
  operationId: string;
  ref: string | null;
  oasVersion: string;
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

function flatten(doc: OasDocument, schema: OasSchema): SchemaNode {
  if (isRefSchema(schema)) {
    return flatten(doc, resolveRef(doc, schema.$ref));
  }
  if (schema.oneOf) {
    // schema-merge handles the actual oneOf union during build-oas; here we
    // just need a comparable flat shape for compare.ts.
    return schema.oneOf
      .map((branch) => flatten(doc, branch))
      .reduce((acc, node) => unionFlat(acc, node));
  }
  if (schema.allOf) {
    // Same flattening strategy as oneOf — the typed skeleton only needs a
    // comparable merged shape, not the distinction between "any of" and "all
    // of" (compare.ts diffs the flat result either way).
    return schema.allOf
      .map((branch) => flatten(doc, branch))
      .reduce((acc, node) => unionFlat(acc, node));
  }
  if (schema.type === "array") {
    return "array";
  }
  if (schema.properties) {
    const node: { [key: string]: SchemaNode } = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      node[key] = flatten(doc, child);
    }
    return node;
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "object";
  }
}

/**
 * Union two flattened branches (oneOf/allOf) into one comparable shape.
 * Two objects merge their keys. An object vs a leaf (e.g. the gate's
 * `GateUnauthorized` object unioned against the real base's `text/plain`
 * string envelope) keeps the OBJECT shape — it carries more structural
 * information than a bare leaf, matching `schema-merge.ts`'s `unionSchema`
 * shape-mismatch rule. Two leaves of different types keep the first
 * (deterministic; mirrors `unionSchema`'s conflict resolution).
 */
function unionFlat(a: SchemaNode, b: SchemaNode): SchemaNode {
  if (typeof a === "object" && typeof b === "object") {
    return { ...a, ...b };
  }
  if (typeof a === "object") return a;
  if (typeof b === "object") return b;
  return a;
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
