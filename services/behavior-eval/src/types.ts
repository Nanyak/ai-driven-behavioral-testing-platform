export type MutationOperator =
  | "drop_field"
  | "null_field"
  | "retype_field"
  | "empty_array"
  | "enum_violation"
  | "const_violation"
  | "range_violation"
  | "format_violation"
  | "status_change";

export interface Mutant {
  id: string;
  endpoint: string;
  status: number;
  operator: MutationOperator;
  path: string | null;
  param?: unknown;
  origin_golden: string;
}

export interface MutationResult {
  mutant: Mutant;
  verdict: "killed" | "survived" | "inconclusive";
  catching_spec?: string;
  evidence?: string;
  applied_count: number;
  reason?: string;
}

export interface MutationMetrics {
  generated_at: string;
  target: string;
  total_mutants: number;
  killed: number;
  survived: number;
  inconclusive: number;
  mutation_score: number;
  executability_rate: number;
  baseline_clean: boolean;
  by_operator: Record<MutationOperator, { killed: number; survived: number }>;
  survivors: Array<{
    endpoint: string;
    status: number;
    operator: MutationOperator;
    path: string | null;
    id: string;
  }>;
  results: MutationResult[];
}
