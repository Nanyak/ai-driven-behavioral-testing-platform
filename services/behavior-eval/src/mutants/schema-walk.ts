import { ignoreFieldsFor } from "../../../golden/src/ignore-fields.js";
import type { GoldenResponse, SchemaNode, SchemaLeaf } from "../../../golden/src/types.js";

export interface SchemaPath {
  path: string;
  leaf: Exclude<SchemaLeaf, "ignored"> | "object";
  depth: number;
}

function isObjectNode(node: SchemaNode): node is { [key: string]: SchemaNode } {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

function normalizePath(path: string): string {
  return path.replace(/\[\]/g, "");
}

function ignoredSegments(golden: GoldenResponse): Set<string> {
  return new Set([...golden.ignore_fields, ...ignoreFieldsFor(golden.endpoint)]);
}

export function isIgnoredPath(golden: GoldenResponse, path: string): boolean {
  const ignored = ignoredSegments(golden);
  const normalized = normalizePath(path);
  if (ignored.has(normalized)) return true;
  for (const segment of normalized.split(".")) {
    if (ignored.has(segment)) return true;
  }
  for (const ignoredPath of ignored) {
    if (ignoredPath.includes(".") && (normalized === ignoredPath || normalized.startsWith(`${ignoredPath}.`))) {
      return true;
    }
  }
  return false;
}

export function walkSchema(golden: GoldenResponse): SchemaPath[] {
  const paths: SchemaPath[] = [];

  function visit(node: SchemaNode, path: string, depth: number): void {
    if (path && isIgnoredPath(golden, path)) return;
    if (node === "ignored") return;
    if (path) {
      paths.push({
        path,
        leaf: isObjectNode(node) ? "object" : node,
        depth,
      });
    }
    if (!isObjectNode(node)) return;
    for (const [key, child] of Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  }

  visit(golden.expected_schema, "", 0);
  return paths;
}
