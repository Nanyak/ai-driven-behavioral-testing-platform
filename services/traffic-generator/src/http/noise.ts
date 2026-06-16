import type { ApiResponse } from "./client.js";
import { chance } from "../util/random.js";

export interface NoiseConfig {
  /** Cut the session short at a random pre-completion step. */
  abandon: boolean;
  abandonProb: number;
  /** After a 4xx, repeat the same call once (corrected or still-wrong). */
  retry: boolean;
  /** Occasionally fire one out-of-persona endpoint inside the session. */
  contaminate: boolean;
  contaminateProb: number;
  /** Randomize product list/detail ordering. */
  shuffle: boolean;
}

/** Light noise: realistic background variation on an otherwise clean session. */
export const LIGHT_NOISE: NoiseConfig = {
  abandon: true,
  abandonProb: 0.4,
  retry: true,
  contaminate: false,
  contaminateProb: 0,
  shuffle: true,
};

type Step = () => Promise<ApiResponse>;

/**
 * Run an ordered list of steps, applying retry-on-4xx noise. Abandonment is
 * applied by the caller (it decides where to cut). Returns once all (surviving)
 * steps have executed.
 */
export async function runSteps(steps: Step[], noise: NoiseConfig): Promise<void> {
  for (const step of steps) {
    const res = await step();
    // Retry input-correction 4xx only. A 401/403 is an auth wall, not a
    // correctable input error — blind-retrying it produces an unrealistic
    // `POST /store/carts 401 ×N` storm (and a junk Phase 7 negative candidate).
    if (
      noise.retry &&
      !res.ok &&
      res.status >= 400 &&
      res.status < 500 &&
      res.status !== 401 &&
      res.status !== 403
    ) {
      await step();
    }
  }
}

/** Truncate a step list at a random index before the last step. */
export function maybeAbandon(steps: Step[], noise: NoiseConfig): Step[] {
  if (!noise.abandon || steps.length <= 1 || !chance(noise.abandonProb)) {
    return steps;
  }
  const cut = 1 + Math.floor(Math.random() * (steps.length - 1));
  return steps.slice(0, cut);
}
