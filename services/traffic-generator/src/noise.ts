import type { ApiResponse } from "./client.js";

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

/** Heavy noise: the dedicated noise-injected session budget (plan §7). */
export const HEAVY_NOISE: NoiseConfig = {
  abandon: true,
  abandonProb: 0.6,
  retry: true,
  contaminate: true,
  contaminateProb: 0.5,
  shuffle: true,
};

export const NO_NOISE: NoiseConfig = {
  abandon: false,
  abandonProb: 0,
  retry: false,
  contaminate: false,
  contaminateProb: 0,
  shuffle: false,
};

export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function chance(probability: number): boolean {
  return Math.random() < probability;
}

type Step = () => Promise<ApiResponse>;

/**
 * Run an ordered list of steps, applying retry-on-4xx noise. Abandonment is
 * applied by the caller (it decides where to cut). Returns once all (surviving)
 * steps have executed.
 */
export async function runSteps(steps: Step[], noise: NoiseConfig): Promise<void> {
  for (const step of steps) {
    const res = await step();
    if (noise.retry && !res.ok && res.status >= 400 && res.status < 500) {
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
