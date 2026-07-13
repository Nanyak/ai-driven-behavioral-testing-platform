import { createHash } from "node:crypto";
import type { GoldenResponse, SchemaLeaf } from "../../../golden/src/types.js";
import type { Mutant, MutationOperator } from "../types.js";
import { retypedValueFor, statusMutation, valueRuleViolation } from "./operators.js";
import { isIgnoredPath, walkSchema, type SchemaPath } from "./schema-walk.js";

export interface GenerateOptions {
  seed?: string;
  maxTotal?: number;
  maxPerGolden?: number;
}

export interface GoldenInput {
  key: string;
  golden: GoldenResponse;
}

const DEFAULT_MAX_PER_GOLDEN = 12;
const DEFAULT_MAX_TOTAL = 150;

function stableId(input: Omit<Mutant, "id">): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

function makeMutant(input: Omit<Mutant, "id">): Mutant {
  return { id: stableId(input), ...input };
}

function isNullable(path: SchemaPath): boolean {
  return path.leaf === "null";
}

function schemaMutants(golden: GoldenResponse, origin: string): Mutant[] {
  const out: Mutant[] = [];
  for (const path of walkSchema(golden)) {
    out.push(
      makeMutant({
        endpoint: golden.endpoint,
        status: golden.expected_status,
        operator: "drop_field",
        path: path.path,
        origin_golden: origin,
      })
    );
    if (!isNullable(path)) {
      out.push(
        makeMutant({
          endpoint: golden.endpoint,
          status: golden.expected_status,
          operator: "null_field",
          path: path.path,
          origin_golden: origin,
        })
      );
    }
    out.push(
      makeMutant({
        endpoint: golden.endpoint,
        status: golden.expected_status,
        operator: "retype_field",
        path: path.path,
        param: retypedValueFor(path.leaf),
        origin_golden: origin,
      })
    );
    if (path.leaf === "array") {
      out.push(
        makeMutant({
          endpoint: golden.endpoint,
          status: golden.expected_status,
          operator: "empty_array",
          path: path.path,
          origin_golden: origin,
        })
      );
    }
  }
  return out;
}

function valueRuleMutants(golden: GoldenResponse, origin: string): Mutant[] {
  return (golden.value_rules ?? [])
    .filter((rule) => !isIgnoredPath(golden, rule.path))
    .map((rule) =>
      makeMutant({
        endpoint: golden.endpoint,
        status: golden.expected_status,
        operator: `${rule.kind}_violation` as MutationOperator,
        path: rule.path,
        param: valueRuleViolation(rule),
        origin_golden: origin,
      })
    );
}

function statusMutant(golden: GoldenResponse, origin: string): Mutant {
  return makeMutant({
    endpoint: golden.endpoint,
    status: golden.expected_status,
    operator: "status_change",
    path: null,
    param: statusMutation(golden.expected_status),
    origin_golden: origin,
  });
}

function priority(mutant: Mutant): number {
  if (mutant.operator.endsWith("_violation")) return 0;
  if (mutant.operator === "status_change") return 2;
  const path = mutant.path ?? "";
  if (/(^|\.)(id|.*_id|created_at|updated_at|deleted_at)(\.|$)/.test(path)) return 4;
  if (/_at(\.|$)/.test(path)) return 3;
  return 1;
}

function seededOrder(seed: string, mutant: Mutant): string {
  return createHash("sha256").update(`${seed}:${mutant.id}`).digest("hex");
}

function capped(mutants: Mutant[], seed: string, max: number): Mutant[] {
  const deduped = [...new Map(mutants.map((m) => [m.id, m])).values()];
  return deduped
    .sort((a, b) => {
      const p = priority(a) - priority(b);
      return p !== 0 ? p : seededOrder(seed, a).localeCompare(seededOrder(seed, b));
    })
    .slice(0, max);
}

export function generateMutants(inputs: GoldenInput[], opts: GenerateOptions = {}): Mutant[] {
  const seed = opts.seed ?? process.env.EVAL_MUTANT_SEED ?? "behavior-eval";
  const maxPerGolden = opts.maxPerGolden ?? Number(process.env.EVAL_MAX_MUTANTS_PER_GOLDEN ?? DEFAULT_MAX_PER_GOLDEN);
  const maxTotal = opts.maxTotal ?? Number(process.env.EVAL_MAX_MUTANTS ?? DEFAULT_MAX_TOTAL);

  const perGolden = inputs.flatMap(({ key, golden }) =>
    capped([...valueRuleMutants(golden, key), statusMutant(golden, key), ...schemaMutants(golden, key)], seed, maxPerGolden)
  );
  return capped(perGolden, seed, maxTotal);
}

export type { SchemaLeaf };
