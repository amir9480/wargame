// Landmarks module: 0..4 lighthouses on the beaches and 0..3 telecommunication towers on the mountains.
//
// Both are single tall structures with their own lights (beams, red beacons), placed after the buildings and before
// the rocks / trees, so those keep clear of them (`clearing`). Each gets a small levelled pad.
// Lighthouses need a sea side (a beach); the ground must be dry, low and gentle with open water close by, and the more of
// its surroundings are sea the better (a headland beats a straight beach). Towers stand on gentle ground high in the
// mountains. Each kind has its own random stream (seeds.ts), and every look detail is seeded by `seed` (render side).

import type { Rng } from '../../core/rng.ts';
import { hash32 } from '../../core/rng.ts';
import { slopeField } from '../grid.ts';
import { WATER_LEVEL, type PlayArea } from '../types.ts';

/** A lighthouse: a tapering tower with a gallery and a lantern room that sends out two rotating beams. */
export interface Lighthouse {
  id: number;
  /** World position of the foot; y = the levelled ground. */
  x: number;
  y: number;
  z: number;
  /** Foot radius (m) and height of the tower body above the foot (the lantern room stands on top of it). */
  radius: number;
  height: number;
  /** Seeds the colours / stripes (render side). */
  seed: number;
  /** Seconds per beam revolution, and the start offset (s) of the first beam (the second is half a turn on). */
  period: number;
  phase: number;
}

/** A telecommunication tower: a guyless lattice mast with dishes and red beacons. */
export interface RadioTower {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Mast height above the foot (m). */
  height: number;
  /** Foot width (m), tapering up. */
  width: number;
  seed: number;
  /** Beacon flash cycle (s) and start offset (s). */
  period: number;
  phase: number;
}

export interface LandmarkInput {
  N: number;
  cell: number;
  play: PlayArea;
  heights: Float32Array;
  mountain: Float32Array;
  riverMask: Uint8Array;
  streamMask: Uint8Array;
  /** Cells that are taken (roads, base areas, buildings, towns); structures keep `KEEP_CLEAR` cells away. */
  clear: Uint8Array;
}

export interface LandmarkResult<T> {
  items: T[];
  /** Cells rocks and trees keep off (the structure plus a margin). */
  clearing: Uint8Array;
}

/** Chance of 0, 1, 2, 3, 4 lighthouses (landlocked maps have none). */
const LIGHTHOUSE_COUNT = [0.2, 0.25, 0.25, 0.2, 0.1];
/** Chance of 0, 1, 2, 3 towers. */
const TOWER_COUNT = [0.3, 0.3, 0.25, 0.15];
/** Cells between two lighthouses / two towers. */
const LIGHTHOUSE_SPACING = 50;
const TOWER_SPACING = 70;
/** Cells a structure keeps from roads, bases, buildings and towns. */
const KEEP_CLEAR = 5;
/** Levelled pad radius and blend width (cells), and the cells rocks / trees keep off round the foot. */
const PAD = 2;
const PAD_BLEND = 3;
const CLEARING = 8;
/** Beach ground: height range (m), steepest slope, and how close the sea must be (cells). */
const BEACH_MIN = 0.5;
const BEACH_MAX = 5;
const BEACH_SLOPE = 0.06;
const SEA_NEAR = 4;
/** Cells looked at round a beach cell to tell a headland from a straight shore. */
const OUTLOOK = 9;
/** Ground a tower needs: mountain height (m), steepest slope. */
const TOWER_MOUNTAIN = 14;
const TOWER_SLOPE = 0.12;
/** Share of the highest eligible mountain height a tower is preferably placed at (mid-slope shoulders, not summits). */
const TOWER_LEVEL = 0.55;
/** Cells from the grid edge nothing is placed in. */
const EDGE_INSET = 10;

const frac = (seed: number, salt: number) => hash32(seed, salt) / 4294967296;

/** Number of items from a cumulative-free probability list (`chances[n]` = chance of n items). */
function rollCount(chances: number[], rng: Rng): number {
  let r = rng();
  for (let n = 0; n < chances.length; n++) {
    r -= chances[n];
    if (r < 0) return n;
  }
  return chances.length - 1;
}

interface Candidate {
  i: number;
  j: number;
  score: number;
}

/** Best-scoring candidates first, at least `spacing` cells apart, up to `count`. */
function pick(candidates: Candidate[], count: number, spacing: number, taken: { i: number; j: number }[] = []): Candidate[] {
  candidates.sort((a, b) => b.score - a.score);
  const out: Candidate[] = [];
  for (const c of candidates) {
    if (out.length >= count) break;
    if ([...out, ...taken].some((o) => Math.hypot(o.i - c.i, o.j - c.j) < spacing)) continue;
    out.push(c);
  }
  return out;
}

/** Levels a disc round (ci, cj) to `level`, blending into the old ground over PAD_BLEND cells. */
function level(heights: Float32Array, N: number, ci: number, cj: number, target: number): void {
  const r = PAD + PAD_BLEND;
  for (let j = cj - r; j <= cj + r; j++) {
    for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const d = Math.hypot(i - ci, j - cj);
      if (d > r) continue;
      const t = d <= PAD ? 1 : 1 - (d - PAD) / PAD_BLEND;
      const w = t * t * (3 - 2 * t);
      const k = j * N + i;
      heights[k] += (target - heights[k]) * w;
    }
  }
}

function markClearing(mask: Uint8Array, N: number, ci: number, cj: number): void {
  for (let j = cj - CLEARING; j <= cj + CLEARING; j++)
    for (let i = ci - CLEARING; i <= ci + CLEARING; i++)
      if (i >= 0 && j >= 0 && i < N && j < N && Math.hypot(i - ci, j - cj) <= CLEARING) mask[j * N + i] = 1;
}

/** True when no taken cell (clear mask) lies within KEEP_CLEAR cells of (ci, cj), or the pad would touch a river / the edge. */
function isFree({ N, clear, riverMask, streamMask }: LandmarkInput, ci: number, cj: number): boolean {
  const r = KEEP_CLEAR + PAD;
  if (ci < r || cj < r || ci >= N - r || cj >= N - r) return false;
  for (let j = cj - r; j <= cj + r; j++)
    for (let i = ci - r; i <= ci + r; i++) {
      const k = j * N + i;
      if (clear[k] || riverMask[k] || streamMask[k]) return false;
    }
  return true;
}

/**
 * 0..4 lighthouses on beaches: dry low gentle ground in the play area with sea within a few cells, more of the
 * surroundings being sea the better. Maps without a sea side have none.
 */
export function placeLighthouses(input: LandmarkInput, rng: Rng, seaSides: number): LandmarkResult<Lighthouse> {
  const { N, cell, play, heights, riverMask } = input;
  const clearing = new Uint8Array(N * N);
  const count = seaSides > 0 ? rollCount(LIGHTHOUSE_COUNT, rng) : 0;
  if (!count) return { items: [], clearing };

  const slope = slopeField(heights, N, cell);
  const sea = (i: number, j: number) => {
    const k = j * N + i;
    return heights[k] < WATER_LEVEL - 0.2 && !riverMask[k];
  };
  const candidates: Candidate[] = [];
  for (let j = play.j0 + EDGE_INSET; j <= play.j1 - EDGE_INSET; j++) {
    for (let i = play.i0 + EDGE_INSET; i <= play.i1 - EDGE_INSET; i++) {
      const k = j * N + i;
      const h = heights[k];
      if (h < BEACH_MIN || h > BEACH_MAX || slope[k] > BEACH_SLOPE) continue;
      // Sea close by (within SEA_NEAR), checked on the four axes and diagonals.
      let near = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        if (sea(i + dx * SEA_NEAR, j + dy * SEA_NEAR)) near = true;
      }
      if (!near || !isFree(input, i, j)) continue;
      // Share of the surroundings that is sea: headlands score high.
      let wet = 0, total = 0;
      for (let dj = -OUTLOOK; dj <= OUTLOOK; dj += 2)
        for (let di = -OUTLOOK; di <= OUTLOOK; di += 2) {
          if (i + di < 0 || j + dj < 0 || i + di >= N || j + dj >= N) continue;
          total++;
          if (sea(i + di, j + dj)) wet++;
        }
      candidates.push({ i, j, score: wet / Math.max(1, total) + rng() * 0.08 });
    }
  }

  const half = ((N - 1) * cell) / 2;
  const items: Lighthouse[] = [];
  for (const c of pick(candidates, count, LIGHTHOUSE_SPACING)) {
    const y = Math.max(heights[c.j * N + c.i], BEACH_MIN);
    level(heights, N, c.i, c.j, y);
    markClearing(clearing, N, c.i, c.j);
    const seed = hash32(c.j * N + c.i, 0x11a7);
    items.push({
      id: items.length,
      x: c.i * cell - half,
      y,
      z: c.j * cell - half,
      radius: 3.6 + frac(seed, 1) * 1.2,
      height: 20 + frac(seed, 2) * 12,
      seed,
      period: 9 + frac(seed, 3) * 5,
      phase: frac(seed, 4) * 14,
    });
  }
  return { items, clearing };
}

/**
 * 0..3 telecommunication towers on the mountains: gentle ground high in a range (or an inland massif), away from
 * roads, rivers and bases. Maps without such ground have none.
 */
export function placeTowers(input: LandmarkInput, rng: Rng, taken: { x: number; z: number }[] = []): LandmarkResult<RadioTower> {
  const { N, cell, heights, mountain } = input;
  const clearing = new Uint8Array(N * N);
  const count = rollCount(TOWER_COUNT, rng);
  if (!count) return { items: [], clearing };

  const slope = slopeField(heights, N, cell);
  const half = ((N - 1) * cell) / 2;
  const eligible: number[] = [];
  let peak = 0;
  for (let j = EDGE_INSET; j < N - EDGE_INSET; j += 2) {
    for (let i = EDGE_INSET; i < N - EDGE_INSET; i += 2) {
      const k = j * N + i;
      if (mountain[k] < TOWER_MOUNTAIN || slope[k] > TOWER_SLOPE || !isFree(input, i, j)) continue;
      eligible.push(k);
      peak = Math.max(peak, mountain[k]);
    }
  }
  // Up on the mountain but not on its summit: ground around TOWER_LEVEL of the highest eligible mountain height scores best.
  const wanted = Math.max(TOWER_MOUNTAIN, peak * TOWER_LEVEL);
  const candidates: Candidate[] = eligible.map((k) => ({
    i: k % N,
    j: Math.floor(k / N),
    score: -Math.abs(mountain[k] - wanted) / Math.max(1, peak) + rng() * 0.25,
  }));
  const takenCells = taken.map((t) => ({ i: (t.x + half) / cell, j: (t.z + half) / cell }));

  const items: RadioTower[] = [];
  for (const c of pick(candidates, count, TOWER_SPACING, takenCells)) {
    const y = heights[c.j * N + c.i];
    level(heights, N, c.i, c.j, y);
    markClearing(clearing, N, c.i, c.j);
    const seed = hash32(c.j * N + c.i, 0x70e5);
    items.push({
      id: items.length,
      x: c.i * cell - half,
      y,
      z: c.j * cell - half,
      height: 15 + frac(seed, 1) * 9,
      width: 2.6 + frac(seed, 2) * 0.8,
      seed,
      period: 1.6 + frac(seed, 3) * 0.6,
      phase: frac(seed, 4) * 3,
    });
  }
  return { items, clearing };
}
