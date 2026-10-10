import { mulberry32, hash32, type Rng } from '../core/rng.ts';

/**
 * Salts for per-stage sub-seeds. Each module draws from its own stream, so
 * adding or changing one module never shifts the randomness of another.
 * Never renumber existing entries: that would change every map.
 * Retired numbers (never reuse): 11 (old cosmetic backdrop).
 */
export const STAGE = { sea: 1, shape: 2, detail: 3, rivers: 4, ranges: 5, rocks: 6, roads: 7, cover: 8, trees: 9, bases: 10, rails: 12, cities: 13, buildings: 14, lighthouses: 15, towers: 16 } as const;

export function stageRng(seed: number, stage: number): Rng {
  return mulberry32(hash32(seed, stage));
}
