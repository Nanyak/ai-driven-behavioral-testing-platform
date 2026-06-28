import type { FlowStep } from "./io/sessions.js";
import type {
  RequestBodyEvidence,
  RequestFieldEvidence,
  SafeScalarEvidence,
} from "./selection/dedup.js";

interface FieldAccumulator {
  count: number;
  masked: boolean;
  types: Set<string>;
  hints: Map<string, SafeScalarEvidence>;
}

function hintKey(type: string, hint: unknown): string {
  return `${type}:${JSON.stringify(hint)}`;
}

/**
 * Aggregate privacy-safe request shape evidence for one operation/outcome.
 * Raw request payloads never enter this artifact.
 */
export function aggregateRequestBodyEvidence(
  sessions: Array<{ steps: FlowStep[] }>,
  method: string,
  endpoint: string,
  status: number
): RequestBodyEvidence | undefined {
  const matches = sessions.flatMap((session) =>
    session.steps.filter(
      (step) =>
        step.method.toUpperCase() === method.toUpperCase() &&
        step.endpoint === endpoint &&
        step.status === status
    )
  );
  if (matches.length === 0) return undefined;

  const fields = new Map<string, FieldAccumulator>();
  const shapes = new Set<string>();
  let presentCount = 0;

  for (const step of matches) {
    const features = step.request_body_features;
    if (!features?.present) continue;
    presentCount++;
    if (features.shape_hash) shapes.add(features.shape_hash);
    const masked = new Set(features.masked_field_paths);

    for (const path of features.field_paths) {
      const acc = fields.get(path) ?? {
        count: 0,
        masked: false,
        types: new Set<string>(),
        hints: new Map<string, SafeScalarEvidence>(),
      };
      acc.count++;
      acc.masked ||= masked.has(path);
      fields.set(path, acc);
    }
    for (const primitive of features.primitive_type_paths) {
      fields.get(primitive.path)?.types.add(primitive.type);
    }
    for (const safe of features.safe_scalar_hints) {
      const acc = fields.get(safe.path);
      if (!acc) continue;
      const key = hintKey(safe.type, safe.hint);
      const existing = acc.hints.get(key);
      if (existing) existing.count++;
      else acc.hints.set(key, { type: safe.type, hint: safe.hint, count: 1 });
    }
  }

  const fieldEvidence: RequestFieldEvidence[] = [...fields.entries()]
    .map(([path, acc]) => ({
      path,
      present_count: acc.count,
      presence_rate: Number((acc.count / matches.length).toFixed(4)),
      masked: acc.masked,
      primitive_types: [...acc.types].sort(),
      safe_hints: [...acc.hints.values()].sort(
        (a, b) => b.count - a.count || String(a.hint).localeCompare(String(b.hint))
      ),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    sample_count: matches.length,
    body_present_count: presentCount,
    shape_count: shapes.size,
    fields: fieldEvidence,
  };
}
