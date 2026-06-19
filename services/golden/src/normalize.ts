/**
 * Strip ignored fields from a live body before comparison (plan §"Compare",
 * step 2). Applies the global ignore list plus any per-endpoint dotted-path
 * additions, mirroring `schema-extract.ts`'s walk.
 */
import { GLOBAL_IGNORE_FIELDS, PER_ENDPOINT_IGNORE_FIELDS } from "./ignore-fields.js";

const GLOBAL_IGNORE_SET = new Set(GLOBAL_IGNORE_FIELDS);

function normalizeAt(value: unknown, path: string, perEndpointPaths: Set<string>): unknown {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (GLOBAL_IGNORE_SET.has(key) || perEndpointPaths.has(childPath)) {
      continue;
    }
    result[key] = normalizeAt(child, childPath, perEndpointPaths);
  }
  return result;
}

/** Strip ignored fields (global + per-endpoint) from a live response body. */
export function normalizeBody(value: unknown, endpoint?: string): unknown {
  const perEndpointPaths = new Set(endpoint ? PER_ENDPOINT_IGNORE_FIELDS[endpoint] ?? [] : []);
  return normalizeAt(value, "", perEndpointPaths);
}
