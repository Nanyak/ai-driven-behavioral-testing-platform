/**
 * Compare (plan §"Compare"). Given a live response and a stored golden:
 * 1. Compare status code first — mismatch short-circuits as a regression.
 * 2. Strip ignored fields from the live body (`normalize.ts`).
 * 3. Compare the live schema against `expected_schema`: missing fields,
 *    unexpected new fields, type changes.
 * 4. Return a structured diff.
 */
import { isObjectNode } from "./schema-extract.js";
import { extractObservedSchema } from "./schema-extract.js";
import { normalizeBody } from "./normalize.js";
import type { GoldenResponse, SchemaNode } from "./types.js";

export type DiffKind = "missing_field" | "unexpected_field" | "type_changed";

export interface SchemaDiffEntry {
  kind: DiffKind;
  path: string;
  expected?: SchemaNode;
  actual?: SchemaNode;
}

export interface CompareResult {
  pass: boolean;
  statusMatch: boolean;
  expectedStatus: number;
  actualStatus: number;
  schemaDiff: SchemaDiffEntry[];
}

function diffSchema(expected: SchemaNode, actual: SchemaNode, path: string): SchemaDiffEntry[] {
  // "ignored" fields are excluded from comparison entirely in both directions.
  if (expected === "ignored" || actual === "ignored") {
    return [];
  }
  if (isObjectNode(expected) && isObjectNode(actual)) {
    const diffs: SchemaDiffEntry[] = [];
    for (const [key, expectedChild] of Object.entries(expected)) {
      if (expectedChild === "ignored") {
        // Ignored fields are excluded from comparison even when normalize.ts
        // has already stripped them out of `actual` entirely.
        continue;
      }
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in actual)) {
        diffs.push({ kind: "missing_field", path: childPath, expected: expectedChild });
        continue;
      }
      diffs.push(...diffSchema(expectedChild, actual[key], childPath));
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) {
        const childPath = path ? `${path}.${key}` : key;
        diffs.push({ kind: "unexpected_field", path: childPath, actual: actual[key] });
      }
    }
    return diffs;
  }
  if (isObjectNode(expected) !== isObjectNode(actual) || expected !== actual) {
    return [{ kind: "type_changed", path: path || "$", expected, actual }];
  }
  return [];
}

/**
 * Compare a live `(status, body)` response against a stored golden. Strips
 * ignore-listed fields from the live body before diffing so dynamic fields
 * (id, timestamps, tokens) never cause a false failure.
 */
export function compareResponse(
  golden: GoldenResponse,
  liveStatus: number,
  liveBody: unknown
): CompareResult {
  const statusMatch = liveStatus === golden.expected_status;
  if (!statusMatch) {
    return {
      pass: false,
      statusMatch,
      expectedStatus: golden.expected_status,
      actualStatus: liveStatus,
      schemaDiff: [],
    };
  }

  const normalized = normalizeBody(liveBody, golden.endpoint);
  const actualSchema = extractObservedSchema(normalized, golden.endpoint);
  const schemaDiff = diffSchema(golden.expected_schema, actualSchema, "");

  return {
    pass: schemaDiff.length === 0,
    statusMatch,
    expectedStatus: golden.expected_status,
    actualStatus: liveStatus,
    schemaDiff,
  };
}
