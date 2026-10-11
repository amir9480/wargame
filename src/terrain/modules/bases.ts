// Player bases module: 4 start locations (player slots 0..3), as far apart as the
// map allows, each on a square of dry, flat, open ground big enough to build a
// military base on. The square is then levelled into a semi-flat plateau.

import type { Rng } from '../../core/rng.ts';
import { lerp, smoothstep } from '../../core/noise.ts';
import { boxBlur, slopeField } from '../grid.ts';
import { WATER_LEVEL, type PlayArea } from '../types.ts';

export const PLAYER_SLOTS = 4;

export interface Base {
  /** Player slot 0..3, assigned clockwise around the map. */
  slot: number;
  /** Centre in world units; y is the levelled ground height. */
  x: number;
  y: number;
  z: number;
  /** Side length of the square build area, world units. */
  size: number;
  /** Build area in grid cells (inclusive). */
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

export interface BaseInput {
  N: number;
  cell: number;
  /** Bases are placed inside this area only. */
  play: PlayArea;
  /** Modified in place: each base square is levelled. */
  heights: Float32Array;
  riverMask: Uint8Array;
  /** Height mountains add per cell. */
  mountain: Float32Array;
}

/** Site rules, tried in order until 4 well-spaced bases fit (small islands need the looser ones). */
// The square is levelled afterwards, so slope rules can relax before the size does.
const RULES = [
  { half: 20, minBuildable: 0.9, maxSlope: 0.15 },
  { half: 20, minBuildable: 0.85, maxSlope: 0.25 },
  { half: 20, minBuildable: 0.8, maxSlope: 0.35 },
  { half: 18, minBuildable: 0.75, maxSlope: 0.4 },
  { half: 16, minBuildable: 0.7, maxSlope: 0.45 },
  { half: 14, minBuildable: 0.6, maxSlope: 0.5 },
];
/** Bases this far apart (fraction of the play area side) count as "far enough". */
const TARGET_GAP = 0.4;
/** Score per cell of base half-size, against cells of spacing. */
const SIZE_WEIGHT = 4;
/** Blend ring around each square when levelling, in cells. */
const FALLOFF = 8;
/** Share of the original relief kept inside the square ("semi-flat"). */
const KEEP_RELIEF = 0.25;

export function placeBases(input: BaseInput, rng: Rng): Base[] {
  const { N, cell, play, heights, riverMask, mountain } = input;
  const slope = slopeField(heights, N, cell);

  // Each rule set gives a candidate layout. Score: spacing up to TARGET_GAP (beyond that,
  // bases are far enough apart) plus base size, so big bases win unless they'd be cramped.
  // Never inside a base, whatever the rule: water, a river (levelling would dam it), real mountain.
  const riverEdge = boxBlur(Float32Array.from(riverMask, (v) => (v ? 1 : 0)), N, 1);
  const hard = new Uint8Array(N * N);
  for (let k = 0; k < hard.length; k++) {
    hard[k] = heights[k] < WATER_LEVEL + 0.8 || riverEdge[k] > 0 || mountain[k] > 3 ? 1 : 0;
  }
  const hardSat = summedArea(hard, N);

  let best: { rule: (typeof RULES)[number]; chosen: { i: number; j: number; fit: number }[]; score: number } | null = null;
  const targetGap = (play.i1 - play.i0 + 1) * TARGET_GAP;
  for (const rule of RULES) {
    // Buildable cell: dry land, no mountain, gentle slope (rivers are excluded by `hard`).
    const ok = new Uint8Array(N * N);
    for (let k = 0; k < ok.length; k++) {
      ok[k] = heights[k] >= WATER_LEVEL + 1.5 && mountain[k] < 1 && slope[k] < rule.maxSlope ? 1 : 0;
    }
    const sat = summedArea(ok, N);
    const R = rule.half;
    const area = (2 * R + 1) ** 2;
    const margin = R + 6;

    const candidates: { i: number; j: number; fit: number }[] = [];
    for (let j = play.j0 + margin; j <= play.j1 - margin; j += 3) {
      for (let i = play.i0 + margin; i <= play.i1 - margin; i += 3) {
        if (boxSum(hardSat, N, i - R, j - R, i + R, j + R) > 0) continue;
        const fit = boxSum(sat, N, i - R, j - R, i + R, j + R) / area;
        if (fit >= rule.minBuildable) candidates.push({ i, j, fit });
      }
    }
    const chosen = pickSpread(candidates, 2 * R + 8, rng);
    if (chosen.length < PLAYER_SLOTS) continue;
    const score = Math.min(minGap(chosen), targetGap) + rule.half * SIZE_WEIGHT;
    if (!best || score > best.score) best = { rule, chosen, score };
  }
  if (!best) return [];

  const { chosen } = best;
  const R = best.rule.half;
  // Slots clockwise around the play area centre (as seen from above), starting north-west.
  const ci = (play.i0 + play.i1) / 2, cj = (play.j0 + play.j1) / 2;
  chosen.sort((a, b) => angle(a.i - ci, a.j - cj) - angle(b.i - ci, b.j - cj));

  const half = ((N - 1) * cell) / 2;
  return chosen.map((p, slot) => {
    const y = level(heights, N, p.i - R, p.j - R, p.i + R, p.j + R);
    return {
      slot,
      x: p.i * cell - half,
      y,
      z: p.j * cell - half,
      size: 2 * R * cell,
      i0: p.i - R,
      j0: p.j - R,
      i1: p.i + R,
      j1: p.j + R,
    };
  });
}

function minGap(set: { i: number; j: number }[]): number {
  let d = Infinity;
  for (let a = 0; a < set.length; a++)
    for (let b = a + 1; b < set.length; b++) d = Math.min(d, Math.hypot(set[a].i - set[b].i, set[a].j - set[b].j));
  return d;
}

/** Clockwise angle from north-west, 0..2PI (grid y points south). */
function angle(dx: number, dy: number): number {
  return (Math.atan2(dy, dx) + Math.PI * 1.75) % (Math.PI * 2);
}

/**
 * 4 candidates maximising the smallest distance between any two (farthest-point
 * selection from several random starts). Ties favour flatter, more open sites.
 */
function pickSpread(cands: { i: number; j: number; fit: number }[], minSpacing: number, rng: Rng) {
  let best: typeof cands = [];
  let bestScore = -Infinity;
  if (!cands.length) return best;
  const nearest = new Float64Array(cands.length);
  for (let trial = 0; trial < 40; trial++) {
    const set = [cands[Math.floor(rng() * cands.length)]];
    // Distance of every candidate to the nearest chosen one, kept up to date as the set grows (the candidate list is long on big maps).
    nearest.fill(Infinity);
    let added = set[0];
    while (set.length < PLAYER_SLOTS) {
      let pick: (typeof cands)[number] | null = null;
      let pickD = -Infinity;
      for (let n = 0; n < cands.length; n++) {
        const c = cands[n];
        const d = Math.min(nearest[n], Math.hypot(added.i - c.i, added.j - c.j));
        nearest[n] = d;
        const score = d + c.fit * 4;
        if (d >= minSpacing && score > pickD) {
          pickD = score;
          pick = c;
        }
      }
      if (!pick) break;
      set.push(pick);
      added = pick;
    }
    if (set.length < PLAYER_SLOTS) continue;
    const score = minGap(set) + set.reduce((s, c) => s + c.fit, 0) * 4;
    if (score > bestScore) {
      bestScore = score;
      best = set;
    }
  }
  return best;
}

/** Levels the square towards its mean height (keeping a little relief), blending out over FALLOFF cells. */
function level(heights: Float32Array, N: number, i0: number, j0: number, i1: number, j1: number): number {
  let sum = 0, count = 0;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++, count++) sum += heights[j * N + i];
  const target = sum / count;

  for (let j = Math.max(0, j0 - FALLOFF); j <= Math.min(N - 1, j1 + FALLOFF); j++) {
    for (let i = Math.max(0, i0 - FALLOFF); i <= Math.min(N - 1, i1 + FALLOFF); i++) {
      const outside = Math.max(i0 - i, i - i1, j0 - j, j - j1, 0); // cells beyond the square's edge
      const w = 1 - smoothstep(0, FALLOFF, outside);
      if (w <= 0) continue;
      const k = j * N + i;
      const flat = target + (heights[k] - target) * KEEP_RELIEF;
      heights[k] = lerp(heights[k], flat, w);
    }
  }
  return target;
}

/** Summed-area table ((N+1)^2) for O(1) box sums. */
export function summedArea(mask: Uint8Array, N: number): Int32Array {
  const S = new Int32Array((N + 1) * (N + 1));
  for (let j = 0; j < N; j++) {
    let row = 0;
    for (let i = 0; i < N; i++) {
      row += mask[j * N + i];
      S[(j + 1) * (N + 1) + i + 1] = S[j * (N + 1) + i + 1] + row;
    }
  }
  return S;
}

export function boxSum(S: Int32Array, N: number, i0: number, j0: number, i1: number, j1: number): number {
  const W = N + 1;
  return S[(j1 + 1) * W + i1 + 1] - S[j0 * W + i1 + 1] - S[(j1 + 1) * W + i0] + S[j0 * W + i0];
}
