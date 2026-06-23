/**
 * Deterministic, read-only OAS lookup: the set of dotted response paths an
 * operation's success schema marks `required`. Consumed ADVISORY-ONLY by the
 * triage agent (services/test-runner/src/triage) to weight a `missing_field`
 * golden diff — a vanished REQUIRED field is a stronger real-regression signal
 * than a vanished optional one.
 *
 * This deliberately stands OUTSIDE the compare oracle: it never imports or
 * mutates compare.ts / SchemaNode, so ADR 0001's deterministic gate path is
 * unchanged. It walks the SAME entry point oas-source.ts uses (operation ->
 * response[status] -> application/json schema) so its dotted paths line up with
 * the diff paths compare.ts emits. Returns null when the operation/response
 * cannot be resolved; every walk degrades gracefully rather than throwing.
 */
import {
  isRefResponse,
  isRefSchema,
  type OasDocument,
  type OasInlineSchema,
  type OasMethod,
  type OasResponse,
  type OasSchema,
} from "./oas-types.js";

function resolveSchema(doc: OasDocument, schema: OasSchema, seen: Set<string>): OasInlineSchema | null {
  if (!isRefSchema(schema)) return schema;
  if (seen.has(schema.$ref)) return null; // cycle guard (Medusa schemas self-reference)
  seen.add(schema.$ref);
  const m = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
  if (!m) return null;
  const target = doc.components.schemas[m[1]];
  return target ? resolveSchema(doc, target, seen) : null;
}

function resolveResponse(doc: OasDocument, response: OasResponse): OasInlineSchema | null {
  if (isRefResponse(response)) {
    const m = /^#\/components\/responses\/(.+)$/.exec(response.$ref);
    if (!m) return null;
    const target = doc.components.responses?.[m[1]];
    return target ? resolveResponse(doc, target) : null;
  }
  const media = response.content?.["application/json"];
  if (!media) return null;
  return resolveSchema(doc, media.schema, new Set());
}

/**
 * Walk an object schema collecting dotted paths the schema (or its nested
 * objects) declare `required`. `oneOf`/`allOf` branches are merged (a field
 * required in ANY branch counts as required, matching how oas-source flattens
 * the comparable shape). Arrays are leaves in the golden model, so we do not
 * descend into `items`.
 */
function collectRequired(
  doc: OasDocument,
  schema: OasInlineSchema | null,
  prefix: string,
  out: Set<string>,
  seen: Set<string>,
): void {
  if (!schema) return;

  for (const branch of schema.oneOf ?? []) {
    collectRequired(doc, resolveSchema(doc, branch, new Set(seen)), prefix, out, seen);
  }
  for (const branch of schema.allOf ?? []) {
    collectRequired(doc, resolveSchema(doc, branch, new Set(seen)), prefix, out, seen);
  }

  for (const name of schema.required ?? []) {
    out.add(prefix ? `${prefix}.${name}` : name);
  }

  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      collectRequired(doc, resolveSchema(doc, child, new Set(seen)), childPath, out, seen);
    }
  }
}

function requiredFromDoc(
  doc: OasDocument,
  method: string,
  endpoint: string,
  status: number,
): Set<string> | null {
  const pathItem = doc.paths[endpoint];
  if (!pathItem) return null;
  const operation = pathItem[method.toLowerCase() as OasMethod];
  if (!operation) return null;
  const rawResponse = operation.responses[String(status)];
  if (!rawResponse) return null;

  const schema = resolveResponse(doc, rawResponse);
  if (!schema) return null;

  const out = new Set<string>();
  collectRequired(doc, schema, "", out, new Set());
  return out;
}

/**
 * Required dotted response paths for `(method, endpoint, status)`, trying Store
 * then Admin (the namespaces never collide). `null` when unresolvable — callers
 * treat that as "required-ness unknown", never as "nothing required".
 */
export function requiredResponsePaths(
  specs: Record<"store" | "admin", OasDocument>,
  method: string,
  endpoint: string,
  status: number,
): Set<string> | null {
  return (
    requiredFromDoc(specs.store, method, endpoint, status) ??
    requiredFromDoc(specs.admin, method, endpoint, status)
  );
}
