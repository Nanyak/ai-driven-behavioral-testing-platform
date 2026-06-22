/**
 * Observed half of the ADR 0001 intersection (plan §"Extraction from observed
 * bodies"). Walks a response JSON tree and classifies each leaf, flagging
 * ignore-listed fields as `"ignored"`. Mirrors
 * `services/log-ingestion/src/pipeline.ts` `describe()`, generalized to take
 * an endpoint so per-endpoint ignore additions (dotted paths) apply too.
 */
import { GLOBAL_IGNORE_FIELDS, PER_ENDPOINT_IGNORE_FIELDS } from "./ignore-fields.js";
import type { SchemaNode } from "./types.js";

const GLOBAL_IGNORE_SET = new Set(GLOBAL_IGNORE_FIELDS);

function perEndpointPathSet(endpoint: string | undefined): Set<string> {
  if (!endpoint) return new Set();
  return new Set(PER_ENDPOINT_IGNORE_FIELDS[endpoint] ?? []);
}

function describeAt(value: unknown, path: string, perEndpointPaths: Set<string>): SchemaNode {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object": {
      const node: { [key: string]: SchemaNode } = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        node[key] =
          GLOBAL_IGNORE_SET.has(key) || perEndpointPaths.has(childPath)
            ? "ignored"
            : describeAt(child, childPath, perEndpointPaths);
      }
      return node;
    }
    default:
      return "object";
  }
}

export function extractObservedSchema(value: unknown, endpoint?: string): SchemaNode {
  return describeAt(value, "", perEndpointPathSet(endpoint));
}

export function isObjectNode(node: SchemaNode): node is { [key: string]: SchemaNode } {
  return typeof node === "object" && node !== null;
}
