// Road geometry: curve smoothing (smoothPath, applied once when a road is created,
// before any junction splits it) and surface heights + bridges (shapeEdge).

import { lerp } from '../../../core/noise.ts';
import { sampleGrid } from '../../grid.ts';
import { WATER_LEVEL, type Point } from '../../types.ts';
import type { GridEdge, GridNode, RoadContext } from './context.ts';
import type { RoadType } from './types.ts';

/** Spacing of curve nodes along a road, in grid cells. */
const POINT_SPACING = 1;
/** Bridge decks keep at least this clearance above the water. */
const DECK_CLEARANCE = 1.6;
/** Dry points kept at each end of a bridge as abutments. */
const ABUTMENT = 2;

export interface ShapedEdge {
  edge: GridEdge;
  /** Smoothed centre line in fractional grid coordinates. */
  pts: Point[];
  /** Road surface height per point. */
  y: number[];
  /** Bridge spans as inclusive point index ranges. */
  bridges: [number, number][];
  /** River index spanned by each bridge. */
  rivers: number[];
}

/**
 * Smooth centre line from a raw grid path: evenly spaced points, ends pinned.
 * Done once per new road; junctions later split the smooth line, so a road
 * passing through a junction keeps one continuous curve.
 */
export function smoothPath(raw: Point[], blocked: Blocked = () => false, minRadius = MIN_RADIUS): Point[] {
  const ends = (i: number) => i === 0 || i === pts.length - 1;
  // Wider bends need more smoothing (Laplacian smoothing spreads a bend ~ sqrt(passes)).
  const scale = (minRadius / MIN_RADIUS) ** 2;
  let pts = relax(resample(chaikin(simplify(raw, 0.75, blocked), 3, blocked), POINT_SPACING), Math.round(10 * scale), blocked);
  enforceRadius(pts, ends, blocked, minRadius);
  repair(pts, raw, blocked);
  // Repaired points can leave kinks: smooth again (still never onto water).
  pts = relax(pts, 6, blocked);
  enforceRadius(pts, ends, blocked, minRadius);
  return pts;
}

/**
 * Grid positions smoothing must not move a road onto (water outside a planned
 * crossing): cutting a corner must never put a road into a river.
 */
export type Blocked = (x: number, y: number) => boolean;

/**
 * Surface heights and bridges of one edge. `ends` = heights at its from / to node, shared by every
 * edge meeting there (default nodeHeight(); level crossings take the railway's height, see railNodeHeights).
 * `flat` = length (cells) at each end kept level at the node height (the flat pad around an intersection).
 */
export function shapeEdge(ctx: ShapeInput, edge: GridEdge, ends?: [number, number], flat: [number, number] = [0, 0]): ShapedEdge {
  const pts = edge.pts.map(([x, y]): Point => [x, y]);
  const riverAt = pts.map(([x, y]) => ctx.riverMask[Math.round(y) * ctx.N + Math.round(x)]);
  const last = pts.length - 1;
  const { y, wet } = surface(ctx, pts, ends ?? [nodeHeight(ctx, pts[0]), nodeHeight(ctx, pts[last])], PROFILE_GRADE[edge.type], flat);

  const bridges = findSpans(wet);
  for (const [s, e] of bridges) {
    // Deck follows the (already smooth) road line, arched to clear the water.
    const ya = y[s], yb = y[e];
    const lift = Math.max(0, WATER_LEVEL + DECK_CLEARANCE - Math.min(ya, yb)) + 0.3;
    for (let i = s; i <= e; i++) {
      const t = (i - s) / (e - s);
      y[i] = lerp(ya, yb, t) + lift * Math.sin(Math.PI * t);
    }
  }
  // Which river each bridge spans: the river id seen most along the span.
  const rivers = bridges.map(([s, e]) => {
    const votes = new Map<number, number>();
    for (let i = s; i <= e; i++) if (riverAt[i]) votes.set(riverAt[i], (votes.get(riverAt[i]) ?? 0) + 1);
    let best = 0, bestVotes = 0;
    for (const [id, v] of votes) if (v > bestVotes) [best, bestVotes] = [id, v];
    return best - 1; // -1: no river cell under it (shouldn't happen)
  });
  return { edge, pts, y, bridges, rivers };
}

/** At most this share of an edge's length is levelled at each end (short edges between two pads still ramp). */
const MAX_FLAT_SHARE = 0.35;

/**
 * Surface along a centre line: ground averaged over nearby dry points, then relaxed -> gentle grade,
 * no bumps, ends pinned at `ends` and level for `flat` cells from each end. `wet` marks points over water (bridge spans).
 */
function surface(
  ctx: ShapeInput, pts: Point[], ends: [number, number], maxGrade: number, flat: [number, number] = [0, 0],
): { y: number[]; wet: boolean[] } {
  const ground = pts.map(([x, y]) => sampleGrid(ctx.heights, ctx.N, x, y));
  const wet = pts.map(([x, y], i) => ground[i] < WATER_LEVEL + 0.25 || ctx.riverMask[Math.round(y) * ctx.N + Math.round(x)] > 0);
  const last = pts.length - 1;
  let y = ground.map((g, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(last, i + 4); k++) {
      if (!wet[k]) {
        s += ground[k];
        c++;
      }
    }
    return c ? s / c : g;
  });
  [y[0], y[last]] = ends;
  for (let pass = 0; pass < 4; pass++) {
    y = y.map((v, i) => (i === 0 || i === last ? v : (y[i - 1] + 2 * v + y[i + 1]) / 4));
  }
  /** Pinned points by priority: 0 free, PIN_PAD level intersection end, PIN_BASE base ground, PIN_NODE node end. */
  const fixed = new Uint8Array(pts.length);
  fixed[0] = fixed[last] = PIN_NODE;
  const along = [0];
  for (let i = 1; i <= last; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  if (flat[0] > 0 || flat[1] > 0) {
    const length = along[last];
    let f0 = Math.min(flat[0], length * MAX_FLAT_SHARE), f1 = Math.min(flat[1], length * MAX_FLAT_SHARE);
    // Leave enough ramp between the level ends to climb from one node height to the other within the grade.
    const ramp = Math.abs(ends[1] - ends[0]) / (maxGrade * ctx.cell) + 1;
    const shrink = Math.min(1, Math.max(0, (length - ramp) / (f0 + f1 || 1)));
    f0 *= shrink;
    f1 *= shrink;
    for (let i = 0; i <= last; i++) {
      if (along[i] <= f0) y[i] = ends[0];
      else if (length - along[i] <= f1) y[i] = ends[1];
      else continue;
      fixed[i] = Math.max(fixed[i], PIN_PAD);
    }
  }
  // Inside a player base the road lies on the levelled ground (bases take priority over intersection pads).
  for (let i = 1; i < last; i++) {
    if (!ctx.keep[Math.round(pts[i][1]) * ctx.N + Math.round(pts[i][0])]) continue;
    y[i] = ground[i];
    fixed[i] = PIN_BASE;
  }
  releasePins(y, along, fixed, maxGrade * ctx.cell);
  // Pins that still can't be joined within the grade (node right beside a base): that span gets the grade it needs,
  // as an even ramp instead of a step.
  const grade = new Float64Array(pts.length).fill(maxGrade);
  for (let a = 0, b = 1; b <= last; b++) {
    if (!fixed[b]) continue;
    const need = Math.abs(y[b] - y[a]) / ((along[b] - along[a]) * ctx.cell || 1);
    if (need > maxGrade) grade.fill(need * 1.001, a + 1, b + 1);
    a = b;
  }
  // The level ends and base stretches join the rest of the profile through the grade limit (ramps, no steps).
  limitGrade(y, pts, ctx.cell, grade, fixed);
  return { y, wet };
}

/**
 * Track height at every level crossing: the railway is profiled as one line from end to end (not per
 * edge between crossings), so crossings don't pin it to the ground and force steps into the track.
 */
export function railNodeHeights(ctx: ShapeInput, nodes: GridNode[], edges: GridEdge[]): Map<number, number> {
  const out = new Map<number, number>();
  const isRail = (id: number) => edges[id].type === 'rail';
  const start = nodes.find((n) => n.edges.length === 1 && isRail(n.edges[0]));
  if (!start) return out;
  // Walk the line: concatenated points, and where each node sits on it.
  const pts: Point[] = [[start.x, start.y]];
  const at: [number, number][] = [];
  let node = start.id, prevEdge = -1;
  for (;;) {
    const next = nodes[node].edges.find((id) => id !== prevEdge && isRail(id));
    if (next === undefined) break;
    const e = edges[next];
    const p = e.from === node ? e.pts : [...e.pts].reverse();
    pts.push(...p.slice(1));
    node = e.from === node ? e.to : e.from;
    prevEdge = next;
    at.push([node, pts.length - 1]);
  }
  const last = pts.length - 1;
  const { y } = surface(ctx, pts, [nodeHeight(ctx, pts[0]), nodeHeight(ctx, pts[last])], PROFILE_GRADE.rail);
  for (const [id, i] of at) if (i !== last) out.set(id, y[i]);
  return out;
}

const PIN_PAD = 1;
const PIN_BASE = 2;
const PIN_NODE = 3;

/**
 * Two pinned heights too close together to ramp between within the grade (`rise` = height per cell of length)
 * would leave a step: unpin the intersection-pad one of each such pair until every pair is reachable. Base ground and
 * node ends are never unpinned; between those the grade limit gives way instead (rare: a node right beside a base).
 */
function releasePins(y: number[], along: number[], fixed: Uint8Array, rise: number): void {
  for (let again = true; again; ) {
    again = false;
    let prev = 0;
    for (let i = 1; i < y.length; i++) {
      if (!fixed[i]) continue;
      if (Math.abs(y[i] - y[prev]) <= rise * (along[i] - along[prev]) + 1e-6) {
        prev = i;
        continue;
      }
      if (fixed[i] !== PIN_PAD && fixed[prev] !== PIN_PAD) {
        // Node ends and base ground both stay (bases outrank road grades): the road takes a steeper ramp here.
        prev = i;
        continue;
      }
      fixed[fixed[i] === PIN_PAD ? i : prev] = 0;
      again = true;
      break;
    }
  }
}

/** Steepest grade after profiling (the ground is then cut / filled to match); railways stay much flatter. */
const PROFILE_GRADE: Record<RoadType, number> = { dirt: 0.25, asphalt: 0.25, rail: 0.07 };

/**
 * Clamp the surface profile to `maxGrade`, sweeping forward and back with both
 * ends (and `fixed` points: level pads at intersections, base ground) pinned. `maxGrade` per step (index = step's
 * end point) or one value. Long valley sides down to a
 * bridge become even ramps instead of steep drops at the bank.
 */
function limitGrade(y: number[], pts: Point[], cell: number, maxGrade: number | ArrayLike<number>, fixed?: Uint8Array): void {
  const gradeAt = (i: number) => (typeof maxGrade === 'number' ? maxGrade : maxGrade[i]);
  const last = y.length - 1;
  const step = (i: number) => Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) * cell;
  for (let sweep = 0; sweep < 3; sweep++) {
    for (let i = 1; i < last; i++) {
      if (fixed?.[i]) continue;
      const d = step(i) * gradeAt(i);
      y[i] = Math.min(y[i - 1] + d, Math.max(y[i - 1] - d, y[i]));
    }
    for (let i = last - 1; i > 0; i--) {
      if (fixed?.[i]) continue;
      const d = step(i + 1) * gradeAt(i + 1);
      y[i] = Math.min(y[i + 1] + d, Math.max(y[i + 1] - d, y[i]));
    }
  }
}

/** Tightest allowed road bend, in grid cells (wider than a road ribbon, so it can't fold). */
const MIN_RADIUS = 3;

/** Repeatedly relaxes points whose bend is tighter than `radius`; fixed points never move. */
function enforceRadius(pts: Point[], fixed: (i: number) => boolean, blocked: Blocked, radius: number): void {
  for (let iter = 0; iter < 200 * Math.max(1, (radius / MIN_RADIUS) ** 2); iter++) {
    let moved = false;
    for (let i = 1; i < pts.length - 1; i++) {
      if (fixed(i)) continue;
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
      const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
      if (!l1 || !l2) continue;
      const cos = ((bx - ax) * (cx - bx) + (by - ay) * (cy - by)) / (l1 * l2);
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (angle < 1e-3 || (l1 + l2) / 2 / angle >= radius) continue;
      const next: Point = [lerp(bx, (ax + cx) / 2, 0.5), lerp(by, (ay + cy) / 2, 0.5)];
      if (blocked(next[0], next[1])) continue;
      pts[i] = next;
      moved = true;
    }
    if (!moved) break;
  }
}

/** Any blocked point left over (e.g. resampled along a chord) goes back to the nearest raw path point. */
function repair(pts: Point[], raw: Point[], blocked: Blocked): void {
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    if (!blocked(x, y)) continue;
    let best = raw[0], bestD = Infinity;
    for (const r of raw) {
      const d = Math.hypot(r[0] - x, r[1] - y);
      if (d < bestD) [best, bestD] = [r, d];
    }
    pts[i] = [best[0], best[1]];
  }
}

/** True if the straight segment a-b passes over a blocked cell. */
function segmentBlocked([ax, ay]: Point, [bx, by]: Point, blocked: Blocked): boolean {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.4);
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    if (blocked(lerp(ax, bx, t), lerp(ay, by, t))) return true;
  }
  return false;
}

export type ShapeInput = Pick<RoadContext, 'N' | 'cell' | 'heights' | 'riverMask' | 'keep'>;

/** Road height at a node: mean ground around it (shared by all roads meeting there). */
export function nodeHeight({ N, heights }: Pick<RoadContext, 'N' | 'heights'>, [x, y]: Point): number {
  let s = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) s += sampleGrid(heights, N, x + dx * 1.5, y + dy * 1.5);
  return s / 9;
}

/** Runs of wet points, merged across short dry gaps and padded with dry abutments. */
function findSpans(wet: boolean[]): [number, number][] {
  const n = wet.length;
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (!wet[i]) continue;
    let j = i;
    while (j + 1 < n && wet[j + 1]) j++;
    const prev = runs[runs.length - 1];
    if (prev && i - prev[1] <= 3) prev[1] = j;
    else runs.push([i, j]);
    i = j;
  }
  return runs.map(([s, e]) => [Math.max(0, s - ABUTMENT), Math.min(n - 1, e + ABUTMENT)]);
}

/** Ramer-Douglas-Peucker: drops the grid staircase while keeping real bends. */
function simplify(pts: Point[], eps: number, blocked: Blocked): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, worstD = eps;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    // Never shortcut across water, even when the path is nearly straight.
    if (worst < 0 && e - s > 1 && segmentBlocked(pts[s], pts[e], blocked)) worst = (s + e) >> 1;
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting; end points stay pinned; a cut that would land on water keeps the corner. */
function chaikin(pts: Point[], iterations: number, blocked: Blocked): Point[] {
  let p = pts;
  for (let it = 0; it < iterations && p.length > 2; it++) {
    const out: Point[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const q: Point = [lerp(a[0], b[0], 0.25), lerp(a[1], b[1], 0.25)];
      const r: Point = [lerp(a[0], b[0], 0.75), lerp(a[1], b[1], 0.75)];
      if (i > 0) out.push(blocked(q[0], q[1]) ? a : q);
      if (i < p.length - 2) out.push(blocked(r[0], r[1]) ? b : r);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/** Laplacian smoothing with pinned ends: widens tight bends to a drivable radius. */
function relax(pts: Point[], passes: number, blocked: Blocked): Point[] {
  let p = pts;
  for (let pass = 0; pass < passes; pass++) {
    p = p.map((q, i) => {
      if (i === 0 || i === p.length - 1) return q;
      const next: Point = [(p[i - 1][0] + 2 * q[0] + p[i + 1][0]) / 4, (p[i - 1][1] + 2 * q[1] + p[i + 1][1]) / 4];
      return blocked(next[0], next[1]) ? q : next;
    });
  }
  return p;
}

/** Evenly spaced points along the polyline, first and last kept exactly. */
function resample(pts: Point[], spacing: number): Point[] {
  if (pts.length < 2) return pts.slice();
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const count = Math.max(1, Math.round(total / spacing));
  const step = total / count;
  const out: Point[] = [pts[0]];
  let seg = 0, segStart = 0;
  let segLen = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  for (let k = 1; k < count; k++) {
    const d = k * step;
    while (d > segStart + segLen && seg < pts.length - 2) {
      segStart += segLen;
      seg++;
      segLen = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
    }
    const t = segLen > 0 ? (d - segStart) / segLen : 0;
    out.push([lerp(pts[seg][0], pts[seg + 1][0], t), lerp(pts[seg][1], pts[seg + 1][1], t)]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
