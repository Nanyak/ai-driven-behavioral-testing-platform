import type { Mutant } from "../types.js";

export interface ApplyMutationResult {
  body: unknown;
  status: number;
  applied: boolean;
}

type Container = Record<string, unknown> | unknown[];

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function pathParts(path: string): Array<{ key: string; array: boolean }> {
  return path.split(".").map((part) => ({
    key: part.replace(/\[\]$/, ""),
    array: part.endsWith("[]"),
  }));
}

function mutateAtPath(
  current: unknown,
  parts: Array<{ key: string; array: boolean }>,
  mutate: (parent: Container, key: string) => boolean
): boolean {
  if (parts.length === 0) return false;
  const [head, ...tail] = parts;

  if (Array.isArray(current)) {
    let applied = false;
    for (const item of current) {
      applied = mutateAtPath(item, parts, mutate) || applied;
    }
    return applied;
  }

  if (current === null || typeof current !== "object") return false;
  const obj = current as Record<string, unknown>;
  if (!(head.key in obj)) return false;

  if (tail.length === 0) {
    if (head.array && !Array.isArray(obj[head.key])) return false;
    return mutate(obj, head.key);
  }

  const next = obj[head.key];
  if (head.array) {
    if (!Array.isArray(next)) return false;
    let applied = false;
    for (const item of next) {
      applied = mutateAtPath(item, tail, mutate) || applied;
    }
    return applied;
  }
  return mutateAtPath(next, tail, mutate);
}

function setValue(body: unknown, path: string, value: unknown): boolean {
  return mutateAtPath(body, pathParts(path), (parent, key) => {
    if (Array.isArray(parent)) return false;
    parent[key] = cloneJson(value);
    return true;
  });
}

function deleteValue(body: unknown, path: string): boolean {
  return mutateAtPath(body, pathParts(path), (parent, key) => {
    if (Array.isArray(parent) || !(key in parent)) return false;
    delete parent[key];
    return true;
  });
}

export function applyMutation(mutant: Mutant, body: unknown, status: number): ApplyMutationResult {
  if (mutant.operator === "status_change") {
    return {
      body,
      status: typeof mutant.param === "number" ? mutant.param : status,
      applied: true,
    };
  }

  if (mutant.path === null) {
    return { body, status, applied: false };
  }

  const nextBody = cloneJson(body);
  let applied = false;
  switch (mutant.operator) {
    case "drop_field":
      applied = deleteValue(nextBody, mutant.path);
      break;
    case "null_field":
      applied = setValue(nextBody, mutant.path, null);
      break;
    case "retype_field":
    case "enum_violation":
    case "const_violation":
    case "range_violation":
    case "format_violation":
      applied = setValue(nextBody, mutant.path, mutant.param);
      break;
    case "empty_array":
      applied = setValue(nextBody, mutant.path, []);
      break;
  }
  return { body: nextBody, status, applied };
}
