import type { ValueRule } from "../../../golden/src/types.js";

export function retypedValueFor(type: string): unknown {
  switch (type) {
    case "string":
      return 0;
    case "number":
      return "not-a-number";
    case "boolean":
      return "not-a-boolean";
    case "array":
      return {};
    case "object":
      return null;
    case "null":
      return "not-null";
    default:
      return null;
  }
}

export function statusMutation(status: number): number {
  if (status >= 200 && status < 300) return 500;
  if (status === 500) return 200;
  return 200;
}

export function valueRuleViolation(rule: ValueRule): unknown {
  switch (rule.kind) {
    case "enum": {
      if (!rule.values.includes("__mutation_violation__")) return "__mutation_violation__";
      if (!rule.values.includes(-999_999)) return -999_999;
      return false;
    }
    case "const": {
      if (typeof rule.value === "number") return rule.value + 1;
      if (typeof rule.value === "boolean") return !rule.value;
      return `${rule.value}__mutation`;
    }
    case "range":
      return rule.min !== undefined ? rule.min - 1 : (rule.max ?? 0) + 1;
    case "format":
      return `not-a-${rule.format}`;
  }
}
