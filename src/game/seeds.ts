import { hash32, mulberry32 } from '../core/rng.ts';

// Sim random streams. Separate from terrain STAGE ids. NEVER renumber; add new ids.
export const SIM_STREAM = { spawn: 1, combat: 2, ai: 3 } as const;

/** Deterministic rng for a sim stream at a given tick (+ optional salt, e.g. player slot). */
export function simRng(seed: number, stream: number, tick: number, salt = 0) {
  return mulberry32(hash32(hash32(seed, stream), (tick * 31 + salt) >>> 0));
}
