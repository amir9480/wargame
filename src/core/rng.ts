// Deterministic PRNG helpers. Everything random in map generation must flow
// through these so the same seed always yields the same map.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash used to derive independent sub-seeds per generation stage, so
// tweaking one stage (e.g. rivers) never shifts the random stream of another.
export function hash32(a: number, b = 0): number {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const MAX_SEED = 4294967295;

export function normalizeSeed(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.abs(n), MAX_SEED);
}
