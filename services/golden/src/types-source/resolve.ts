/**
 * Code-derived golden resolver. Given a tested `METHOD /path` op, builds a
 * `GoldenResponse` whose schema comes from the version-matched `@medusajs/types`
 * package (via `extract.ts`) instead of Medusa's drifted published OpenAPI.
 *
 * The ignore policy (global + per-endpoint) is applied exactly as `buildGolden`
 * does, and any CURATED per-golden `ignore_fields` from an existing golden are
 * PRESERVED — repair/triage curation (e.g. store `product.status`, which the
 * store API omits from the shared type) must survive a rebuild.
 */
import { createTypesExtractor, type TypesExtractor } from "./extract.js";
import { responseTypeFor } from "./endpoint-types.js";
import { GLOBAL_IGNORE_FIELDS, ignoreFieldsFor } from "../ignore-fields.js";
import type { GoldenResponse, SchemaNode } from "../types.js";

const GLOBAL = new Set<string>(GLOBAL_IGNORE_FIELDS);

/** Mark global-ignore field NAMES (any depth) and curated dotted PATHS as "ignored". */
function applyIgnorePolicy(node: SchemaNode, paths: Set<string>, prefix = ""): SchemaNode {
  if (typeof node !== "object") return node;
  const out: { [k: string]: SchemaNode } = {};
  for (const [k, v] of Object.entries(node)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    out[k] = GLOBAL.has(k) || paths.has(dotted) ? "ignored" : applyIgnorePolicy(v, paths, dotted);
  }
  return out;
}

export interface TypesGoldenResolver {
  version: string;
  /**
   * Build a code-derived golden for an op, or null when no type is mapped for
   * it (caller falls back to the OpenAPI/observed source). `existingIgnore` is
   * the prior golden's `ignore_fields`, whose curated (non-default) entries are
   * carried forward.
   */
  build(
    method: string,
    endpoint: string,
    status: number,
    existingIgnore?: readonly string[]
  ): GoldenResponse | null;
}

export function createTypesGoldenResolver(backendDir: string): TypesGoldenResolver {
  const extractor: TypesExtractor = createTypesExtractor(backendDir);
  return {
    version: extractor.version,
    build(method, endpoint, status, existingIgnore) {
      if (status < 200 || status >= 300) return null; // 2xx only; errors stay overlay/observed
      const typeName = responseTypeFor(method, endpoint);
      if (!typeName) return null;
      const raw = extractor.resolve(typeName);
      if (!raw) return null;

      const endpointKey = `${method.toUpperCase()} ${endpoint}`;
      const defaultIgnore = ignoreFieldsFor(endpointKey); // global + PER_ENDPOINT dotted paths
      // Carry forward curated dotted paths added by prior repair/triage.
      const curated = (existingIgnore ?? []).filter((f) => f.includes("."));
      const ignoreFields = [...new Set([...defaultIgnore, ...curated])];
      const schema = applyIgnorePolicy(raw, new Set(ignoreFields.filter((f) => f.includes("."))));

      return {
        endpoint: endpointKey,
        expected_status: status,
        expected_schema: schema,
        ignore_fields: ignoreFields,
        schema_source: "types",
        oas_operation_id: typeName,
        oas_ref: `@medusajs/types#${typeName}`,
        oas_version: extractor.version,
        value_rules: [],
        captured_at: new Date().toISOString(),
        source_sessions: [],
      };
    },
  };
}
