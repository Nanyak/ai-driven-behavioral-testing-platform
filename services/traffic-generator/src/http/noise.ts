import type { ApiResponse } from "./client.js";
import { chance } from "../util/random.js";

export interface NoiseConfig {
  abandon: boolean;
  abandonProb: number;
  retry: boolean;
  contaminate: boolean;
  contaminateProb: number;
  shuffle: boolean;
}

export const LIGHT_NOISE: NoiseConfig = {
  abandon: true,
  abandonProb: 0.4,
  retry: true,
  contaminate: false,
  contaminateProb: 0,
  shuffle: true,
};

type Step = () => Promise<ApiResponse>;

/** Abandonment is applied by the caller (it decides where to cut). */
export async function runSteps(steps: Step[], noise: NoiseConfig): Promise<void> {
  for (const step of steps) {
    const res = await step();
    // Retry input-correction 4xx only. A 401/403 is an auth wall, not a
    // correctable input error — blind-retrying it produces an unrealistic
    // `POST /store/carts 401 ×N` storm (and a junk negative candidate).
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

export function maybeAbandon(steps: Step[], noise: NoiseConfig): Step[] {
  if (!noise.abandon || steps.length <= 1 || !chance(noise.abandonProb)) {
    return steps;
  }
  const cut = 1 + Math.floor(Math.random() * (steps.length - 1));
  return steps.slice(0, cut);
}
