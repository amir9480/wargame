// River crossings: each river gets 2..4 planned bridge sites, spread along its
// length at narrow spots with gentle, dry banks. Roads may only cross rivers here.

import type { Rng } from '../../../core/rng.ts';
import { WATER_LEVEL, type GridPoint, type Point } from '../../types.ts';
import type { RoadContext } from './context.ts';

export interface Crossing {
  id: number;
  /** Index of the river (into Terrain.rivers). */
  river: number;
  /** Dry bank points on either side, in grid cells. */
  a: GridPoint;
  b: GridPoint;
  /** Approach points further out on the same line: roads reach the bridge straight. */
  approachA: GridPoint;
  approachB: GridPoint;
  /** River centre line point being crossed. */
  center: Point;
}

const MIN_CROSSINGS = 2;
const MAX_CROSSINGS = 4;
/** Straight approach length beyond each bank, in cells (at least MIN_APPROACH). */
const APPROACH = 5;
const MIN_APPROACH = 3;
/** Crossings stay this many cells inside the play area border. */
const BORDER = 8;

/** Site rules: strict first; relaxed only where a stretch of river has no strict site. */
interface Limits {
  /** Widest crossing, bank to bank, in cells. */
  span: number;
  /** Banks higher than this are mountain gorges. */
  bankHeight: number;
  /** Steepest bank (1 - normal.y). */
  bankSlope: number;
}
const STRICT: Limits = { span: 16, bankHeight: 14, bankSlope: 0.3 };
const RELAXED: Limits = { span: 22, bankHeight: 22, bankSlope: 0.45 };

export interface CrossingPlan {
  crossings: Crossing[];
  /** Crossing id + 1 on the corridor cells of each crossing, else 0. */
  corridor: Int16Array;
}

export function planCrossings(ctx: RoadContext, riverPaths: Point[][], rng: Rng): CrossingPlan {
  const { N } = ctx;
  const crossings: Crossing[] = [];
  const corridor = new Int16Array(N * N);
  const inside = (p: Point, border: number) => inPlay(ctx, p, border);
  /** Index range of the path at least `border` cells inside the play area. */
  const usableRange = (path: Point[], border: number): [number, number] => {
    let lo = 0, hi = path.length - 1;
    while (lo < hi && !inside(path[lo], border)) lo++;
    while (hi > lo && !inside(path[hi], border)) hi--;
    return [lo, hi];
  };
  const add = (c: Omit<Crossing, 'id'>) => {
    const crossing = { ...c, id: crossings.length };
    crossings.push(crossing);
    markCorridor(corridor, N, crossing);
  };

  riverPaths.forEach((path, river) => {
    const want = MIN_CROSSINGS + Math.floor(rng() * (MAX_CROSSINGS - MIN_CROSSINGS + 1));
    const mine: Omit<Crossing, 'id'>[] = [];

    // Main pass: one crossing per equal share of the river, so they spread out along it.
    const [lo, hi] = usableRange(path, BORDER);
    const usable = hi - lo;
    if (usable >= 8) {
      const count = Math.min(want, Math.floor(usable / 8)); // keep ~8+ cells apart on short rivers
      for (let s = 0; s < count; s++) {
        const margin = Math.min(3, Math.floor(usable / count / 4));
        const from = Math.round(lo + (usable * s) / count) + margin;
        const to = Math.round(lo + (usable * (s + 1)) / count) - margin;
        const best = bestSite(ctx, path, river, from, to, [STRICT, RELAXED], rng, mine);
        if (best) mine.push(best);
      }
    }

    // Fallback: short or awkward rivers still get MIN_CROSSINGS if any site exists
    // anywhere along them (closer to the border, relaxed rules, still spaced apart).
    const [flo, fhi] = usableRange(path, 3);
    while (mine.length < MIN_CROSSINGS) {
      const best = bestSite(ctx, path, river, flo + 1, fhi - 1, [RELAXED], rng, mine);
      if (!best) break;
      mine.push(best);
    }
    mine.forEach(add);
  });
  return { crossings, corridor };
}

/** Bridges matter for gameplay, so they all go inside the play area, `border` cells from its edge. */
function inPlay({ play }: RoadContext, [x, y]: Point, border: number): boolean {
  return x >= play.i0 + border && y >= play.j0 + border && x <= play.i1 - border && y <= play.j1 - border;
}

/** Best-scoring crossing site in path[from..to], trying each rule set in turn; spaced from `taken`. */
function bestSite(
  ctx: RoadContext, path: Point[], river: number, from: number, to: number,
  rules: Limits[], rng: Rng, taken: Omit<Crossing, 'id'>[],
): Omit<Crossing, 'id'> | null {
  if (to < from) return null;
  const jitter = Array.from({ length: to - from + 1 }, () => rng() * 1.5);
  for (const limits of rules) {
    let best: Omit<Crossing, 'id'> | null = null;
    let bestScore = Infinity;
    for (let i = from; i <= to; i++) {
      if (!inPlay(ctx, path[i], 3)) continue; // the river may wander out of the play area and back
      const c = evaluate(ctx, path, i, river, limits);
      if (!c) continue;
      const [cx, cy] = c.crossing.center;
      if (taken.some((t) => Math.hypot(t.center[0] - cx, t.center[1] - cy) < 6)) continue;
      const score = c.score + jitter[i - from];
      if (score < bestScore) [best, bestScore] = [c.crossing, score];
    }
    if (best) return best;
  }
  return null;
}

function evaluate(
  { N, heights, slope, riverMask }: RoadContext, path: Point[], i: number, river: number, limits: Limits,
): { crossing: Omit<Crossing, 'id'>; score: number } | null {
  const W = WATER_LEVEL;
  const [px, py] = path[i];
  const p0 = path[Math.max(0, i - 3)], p1 = path[Math.min(path.length - 1, i + 3)];
  const tl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
  const nx = -(p1[1] - p0[1]) / tl, ny = (p1[0] - p0[0]) / tl; // across the river

  // Walk out from the centre until dry land, then a little further onto the bank.
  const bank = (dir: number): GridPoint | null => {
    for (let d = 0.5; d <= limits.span / 2; d += 0.5) {
      const x = Math.round(px + nx * d * dir), y = Math.round(py + ny * d * dir);
      if (x < 1 || y < 1 || x > N - 2 || y > N - 2) return null;
      const k = y * N + x;
      if (riverMask[k] && riverMask[k] !== river + 1) return null; // another river (confluence)
      if (heights[k] < W + 0.6 || riverMask[k]) continue;
      const bx = Math.round(px + nx * (d + 2) * dir), by = Math.round(py + ny * (d + 2) * dir);
      if (bx < 1 || by < 1 || bx > N - 2 || by > N - 2) return null;
      return { x: bx, y: by };
    }
    return null; // still water: too wide, or open sea
  };
  const a = bank(-1), b = bank(1);
  if (!a || !b) return null;

  const ka = a.y * N + a.x, kb = b.y * N + b.x;
  const ha = heights[ka], hb = heights[kb];
  if (ha < W + 0.6 || hb < W + 0.6 || ha > limits.bankHeight || hb > limits.bankHeight) return null;
  if (slope[ka] > limits.bankSlope || slope[kb] > limits.bankSlope) return null;
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  if (span > limits.span) return null;

  // Prefer short spans, level banks of similar height.
  const score = span + Math.abs(ha - hb) * 0.5 + (slope[ka] + slope[kb]) * 20;
  // Straight approach on dry land beyond each bank (shortened if it runs into water or off the map).
  const approach = (from: GridPoint, dir: number): GridPoint => {
    let best = from;
    for (let d = 1; d <= APPROACH; d++) {
      const x = Math.round(from.x + nx * d * dir), y = Math.round(from.y + ny * d * dir);
      if (x < 1 || y < 1 || x > N - 2 || y > N - 2) break;
      const k = y * N + x;
      if (heights[k] < W + 0.6 || riverMask[k]) break;
      best = { x, y };
    }
    return best;
  };
  const approachA = approach(a, -1), approachB = approach(b, 1);
  // Banks with no room for a straight approach (e.g. a thin strip between two rivers) are dead ends.
  if (Math.hypot(approachA.x - a.x, approachA.y - a.y) < MIN_APPROACH) return null;
  if (Math.hypot(approachB.x - b.x, approachB.y - b.y) < MIN_APPROACH) return null;
  return { crossing: { river, a, b, approachA, approachB, center: [px, py] }, score };
}

/** Cells within 1 of the approach-to-approach segment (bridge plus straight approaches). */
function markCorridor(corridor: Int16Array, N: number, c: Crossing): void {
  const { approachA: a, approachB: b } = c;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = Math.min(a.y, b.y) - 1; y <= Math.max(a.y, b.y) + 1; y++) {
    for (let x = Math.min(a.x, b.x) - 1; x <= Math.max(a.x, b.x) + 1; x++) {
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      if (Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)) <= 1) corridor[y * N + x] = c.id + 1;
    }
  }
}
