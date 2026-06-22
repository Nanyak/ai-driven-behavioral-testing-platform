import type { ApiResponse } from "./client.js";

/** The unit Phase 7 mines. */
export interface StepResult {
  action: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
}

/**
 * Sentinel response for a step whose runtime preconditions were not met (e.g. no
 * product to view, no cart to complete). It records the intent without a network
 * call. `ok` is false so retry/abandon logic treats it like any other miss.
 */
export const MISSING: ApiResponse = { status: 0, ok: false, body: null };

export function recordStep(
  steps: StepResult[],
  action: string,
  method: string,
  path: string,
  res: ApiResponse
): ApiResponse {
  steps.push({ action, method, path, status: res.status, ok: res.ok });
  return res;
}
