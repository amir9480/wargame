// Rivers module: 1..4 rivers entering from land edges and flowing to the sea
// (or across the map on landlocked maps), carved into the heightmap.
// They start and end at the outer edge of the whole grid, crossing the play area.

import type { Rng } from '../../core/rng.ts';
import { smoothstep, lerp, type Noise2D } from '../../core/noise.ts';
import { sampleGrid, outerEdgePoint } from '../grid.ts';
import { SIDES, WATER_LEVEL, type PlayArea, type Point, type Side } from '../types.ts';
import type { SeaSide } from './sea.ts';

export interface River {
  length: number;
  /** Land edge the river enters from. */
  from: Side;
  /** Sea edge it flows to, or the edge it leaves the map through on landlocked maps. */
  to: Side;
  tributary: boolean;
  /**
   * Mountain stream feeding the river (world units, spring -> the river's first point), or empty: where the river comes
   * out of a range it springs partway up the slope and runs down to the foot. `y` = water surface, falling to
   * WATER_LEVEL at the foot; `width` = water width (m).
   */
  stream: StreamPoint[];
}

export interface StreamPoint {
  x: number;
  y: number;
  z: number;
  width: number;
}

/** A stream in grid coordinates (`y` = water surface per point), carved by `carveStreams` after the banks are blurred. */
export interface Stream {
  pts: Point[];
  y: number[];
}

export interface RiverResult {
  rivers: River[];
  /** River id + 1 (index into `rivers`) where a river bed was carved, else 0. */
  mask: Uint8Array;
  /** Centre line of each river in grid coordinates, same order as `rivers`. */
  paths: Point[][];
  /** Mountain streams to carve (`carveStreams`). */
  streams: Stream[];
}

/** A river passing this close (cells) to another river joins it. */
const JOIN_DIST = 7;
/** River beds are kept at least this far below the waterline after bank softening. */
const BED_DEPTH = 0.35;
/**
 * Mountain height (m, relief `mountain` field) above which a river's ends are dropped: a river coming from (or
 * leaving through) a mountain range springs from its foot instead of cutting a sea-level gorge through it.
 */
const SPRING_MOUNTAIN = 5;
/** Ground height (m) above which the valley stops widening, so a river crossing high ground cuts a gorge, not a basin. */
const VALLEY_HEIGHT_MAX = 25;
/** A stream springs where the ground reaches this share of the mountain it comes out of (above the foot). */
const SPRING_SHARE = 0.5;
/** Least rise (m) from foot to spring for a stream to be worth it, and fewest points. */
const STREAM_MIN_RISE = 6;
const STREAM_MIN_POINTS = 6;
/** Steepest average / local fall of a stream's water surface (m per m). */
const STREAM_GRADE = 0.6;
/** Deepest the stream may cut under the ground where the slope is steeper than STREAM_GRADE (m). */
const STREAM_MAX_CUT = 6;
/** Water surface below the ground it runs over (m), and points over which it eases into the river at the foot. */
const STREAM_SINK = 1;
const STREAM_TAPER = 8;
/** Channel half width (cells) at the spring and at the foot; banks blend out over STREAM_BANK cells. */
const STREAM_HALF = [0.6, 1.0];
const STREAM_BANK = 3;

/**
 * `mountain` = height the relief's peaks add per cell; `rangeSides` = edges walled off by a mountain range. `cell` /
 * the grid size give the streams' world coordinates.
 */
export function carveRivers(
  heights: Float32Array, mountain: Float32Array, N: number, cell: number, play: PlayArea, seaSides: SeaSide[], rangeSides: Side[],
  rng: Rng, noise: Noise2D,
): RiverResult {
  const streams: Stream[] = [];
  const W = WATER_LEVEL;
  const original = heights.slice();
  const riverMask = new Uint8Array(N * N);
  const count = 1 + Math.floor(rng() * 4); // 1..4
  const sources: { x: number; y: number }[] = [];
  const rivers: River[] = [];
  const paths: Point[][] = [];

  const seaSet = new Set(seaSides.map((s) => s.side));
  // Rivers flow in from off-map, so they enter through a land (non-sea) edge.
  // There is always at least one, since at most 3 sides are sea.
  const landSides = SIDES.filter((s) => !seaSet.has(s));

  for (let r = 0; r < count; r++) {
    const from = landSides[Math.floor(rng() * landSides.length)];
    // Flow to the sea if there is one, otherwise exit through another edge
    // (opposite edge more often than an adjacent one).
    const opposite = SIDES[(SIDES.indexOf(from) + 2) % 4];
    const to: Side = seaSides.length
      ? seaSides[Math.floor(rng() * seaSides.length)].side
      : rng() < 0.6 ? opposite : SIDES[(SIDES.indexOf(from) + (rng() < 0.5 ? 1 : 3)) % 4];

    // Source on the entry edge: must be dry land (an edge adjacent to the sea
    // turns to water near the corner) and spaced away from other sources.
    let source: { x: number; y: number; along: number } | null = null;
    for (let k = 0; k < 40 && !source; k++) {
      const along = 0.15 + rng() * 0.7;
      const p = outerEdgePoint(from, along, N, play);
      const inward = outerEdgePoint(from, along, N, play, 8);
      if (sampleGrid(original, N, p.x, p.y) < W + 1) continue;
      if (sampleGrid(original, N, inward.x, inward.y) < W + 1) continue;
      if (sources.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < (play.i1 - play.i0) * 0.2)) continue;
      source = { ...p, along };
    }
    if (!source) continue;
    sources.push(source);

    const targetAlong = to === opposite
      ? source.along + (rng() - 0.5) * 0.6
      : 0.2 + rng() * 0.6;
    const targetAlong01 = Math.min(0.9, Math.max(0.1, targetAlong));
    // Waypoints: straight in to the play area border, across the play area to its far border,
    // then out to the edge of the grid. So the river crosses the play area instead of cutting
    // a corner through the surroundings.
    const waypoints = [
      outerEdgePoint(from, source.along, N, play, play.i0),
      outerEdgePoint(to, targetAlong01, N, play, play.i0),
      outerEdgePoint(to, targetAlong01, N, play),
    ];
    let wp = 0;

    const path: Point[] = [];
    let x = source.x, y = source.y;
    const phase = rng() * 1000;
    let joined = false;
    for (let step = 0; step < N * 4; step++) {
      path.push([x, y]);
      while (wp < waypoints.length - 1 && Math.hypot(waypoints[wp].x - x, waypoints[wp].y - y) < 4) wp++;
      const dx = waypoints[wp].x - x, dy = waypoints[wp].y - y;
      if (Math.hypot(dx, dy) < 1.5) break;
      // Meander stays < PI/2 off the target heading, so the river always progresses.
      // Faded in over the first steps so the river leaves the edge heading inward.
      const meander = Math.min(1, step / 15);
      const angle =
        Math.atan2(dy, dx) +
        meander * (noise(step * 0.035 + phase, r * 13.7) * 1.1 +
                   noise(step * 0.12 + phase, r * 7.1 + 50) * 0.35);
      x += Math.cos(angle);
      y += Math.sin(angle);
      if (x < 0 || y < 0 || x > N - 1 || y > N - 1) break;
      if (step > 5 && sampleGrid(original, N, x, y) < W - 1.5) {
        path.push([x, y]); // reached open water
        break;
      }
      // Close to another river: run straight into it as a tributary (left apart,
      // the two would be split by a thin dry bank).
      const near = step > 20 ? nearestRiver(riverMask, N, x, y, JOIN_DIST) : null;
      if (near) {
        const d = Math.hypot(near[0] - x, near[1] - y);
        for (let s = 1; s <= Math.ceil(d); s++) path.push([lerp(x, near[0], s / Math.ceil(d)), lerp(y, near[1], s / Math.ceil(d))]);
        joined = true;
        break;
      }
    }
    // Spring from / sink at the foot of a range at the map edge rather than cutting through it.
    // Never through a range on the edge either (its saddles would become slot canyons): ends on a range side stop at the
    // play area border at the latest.
    const inMountain = ([px, py]: Point) => sampleGrid(mountain, N, px, py) > SPRING_MOUNTAIN;
    const beyond = (side: Side, [px, py]: Point) => rangeSides.includes(side) && outsidePlay(play, side, px, py);
    let head = 0, tail = path.length;
    while (head < tail && (inMountain(path[head]) || beyond(from, path[head]))) head++;
    // A river that reached the sea (or another river) keeps its mouth: the mountain field can stay up offshore.
    const reachedSea = sampleGrid(original, N, ...path[path.length - 1]) < W;
    if (!joined && !reachedSea) while (tail > head && (inMountain(path[tail - 1]) || beyond(to, path[tail - 1]))) tail--;
    // The dropped head, if it came down a mountain, becomes the stream feeding the river.
    const stream = tail - head >= 12 ? planStream(original, N, cell, path.slice(0, head + 1)) : null;
    path.splice(tail);
    path.splice(0, head);
    if (path.length < 12) continue;

    carvePath(heights, original, riverMask, N, path, rivers.length + 1);
    const half = ((N - 1) * cell) / 2;
    rivers.push({
      length: path.length, from, to, tributary: joined,
      stream: stream
        ? stream.pts.map(([px, py], i) => ({ x: px * cell - half, y: stream.y[i], z: py * cell - half, width: 2 * streamHalf(i, stream.pts.length) * cell }))
        : [],
    });
    paths.push(path);
    if (stream) streams.push(stream);
  }
  return { rivers, mask: riverMask, paths, streams };
}

/**
 * Stream down the mountain part of a river's course (`head`: entry .. the river's first point, grid cells): from where
 * the ground reaches SPRING_SHARE of the mountain's height above the foot (or lower, so the stream averages at most
 * STREAM_GRADE), down to the foot. The water surface follows the ground STREAM_SINK below, never rising downstream nor
 * steeper than STREAM_GRADE (it cuts a small ravine there), and eases to WATER_LEVEL at the foot. Null if too small.
 */
function planStream(ground: Float32Array, N: number, cell: number, head: Point[]): Stream | null {
  const g = head.map(([x, y]) => sampleGrid(ground, N, x, y));
  const step = head.map((p, i) => (i ? Math.hypot(p[0] - head[i - 1][0], p[1] - head[i - 1][1]) * cell : 0));
  const foot = g[g.length - 1];
  const peak = Math.max(...g);
  if (peak - foot < STREAM_MIN_RISE / SPRING_SHARE) return null;
  // Spring: going up from the foot, the first point at the target height, or the last before the grade-limited water
  // line would sit more than STREAM_MAX_CUT under the ground (a slot instead of a stream).
  const target = foot + (peak - foot) * SPRING_SHARE;
  let s = g.length - 1, line = foot - STREAM_SINK;
  while (s > 0 && g[s] < target) {
    const up = Math.min(g[s - 1] - STREAM_SINK, line + STREAM_GRADE * step[s]);
    if (g[s - 1] - up > STREAM_MAX_CUT) break;
    line = Math.max(line, up);
    s--;
  }
  const pts = head.slice(s), raw = g.slice(s), dist = step.slice(s);
  const n = pts.length;
  if (n < STREAM_MIN_POINTS || raw[0] - foot < STREAM_MIN_RISE) return null;
  // Smoothed ground minus the sink, eased to the waterline over the last points.
  const smooth = raw.map((_, i) => {
    let sum = 0, w = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) [sum, w] = [sum + raw[k], w + 1];
    const t = smoothstep(n - 1 - STREAM_TAPER, n - 1, i);
    return lerp(sum / w - STREAM_SINK, WATER_LEVEL, t);
  });
  // Filled from the foot up: never rising downstream, never steeper than STREAM_GRADE.
  const y = new Array<number>(n);
  y[n - 1] = WATER_LEVEL;
  for (let i = n - 2; i >= 0; i--) y[i] = Math.max(y[i + 1], Math.min(smooth[i], y[i + 1] + STREAM_GRADE * dist[i + 1]));
  return { pts, y };
}

function streamHalf(i: number, n: number): number {
  return lerp(STREAM_HALF[0], STREAM_HALF[1], i / Math.max(1, n - 1));
}

/**
 * Carves the streams' channels (after the river banks are blurred, so they stay crisp): under the water the bed is set
 * a little below the surface (cut or filled, from the nearest stream point); the banks only ever cut down towards it.
 * Returns a mask of the channel cells (+1 cell), for things that keep off water.
 */
export function carveStreams(heights: Float32Array, N: number, streams: Stream[]): Uint8Array {
  const mask = new Uint8Array(N * N);
  const ground = heights.slice();
  const dist = new Float32Array(N * N).fill(Infinity);
  for (const { pts, y } of streams) {
    pts.forEach(([px, py], i) => {
      const r = streamHalf(i, pts.length), R = r + STREAM_BANK;
      for (let j = Math.max(0, Math.floor(py - R)); j <= Math.min(N - 1, Math.ceil(py + R)); j++) {
        for (let x = Math.max(0, Math.floor(px - R)); x <= Math.min(N - 1, Math.ceil(px + R)); x++) {
          const d = Math.hypot(x - px, j - py);
          if (d > R) continue;
          const k = j * N + x;
          if (d <= r + 1) mask[k] = 1;
          if (d <= r) {
            if (d >= dist[k]) continue;
            dist[k] = d;
            const q = d / r;
            heights[k] = y[i] - 0.3 - 0.6 * (1 - q * q);
          } else if (dist[k] === Infinity) {
            const bank = lerp(y[i] + 0.2, ground[k], smoothstep(r, R, d));
            if (bank < heights[k]) heights[k] = bank;
          }
        }
      }
    });
  }
  return mask;
}

/**
 * Keeps every river bed under water. Blurring the carved banks lifts narrow
 * stretches and tight bends above the waterline, leaving dry gaps in the river.
 */
export function wetRiverBeds(heights: Float32Array, riverMask: Uint8Array): void {
  for (let k = 0; k < heights.length; k++)
    if (riverMask[k] && heights[k] > WATER_LEVEL - BED_DEPTH) heights[k] = WATER_LEVEL - BED_DEPTH;
}

/** Nearest river cell within `radius` of (px, py), or null. */
function nearestRiver(riverMask: Uint8Array, N: number, px: number, py: number, radius: number): Point | null {
  let best: Point | null = null, bestD = radius;
  for (let y = Math.max(0, Math.floor(py - radius)); y <= Math.min(N - 1, Math.ceil(py + radius)); y++)
    for (let x = Math.max(0, Math.floor(px - radius)); x <= Math.min(N - 1, Math.ceil(px + radius)); x++) {
      if (!riverMask[y * N + x]) continue;
      const d = Math.hypot(x - px, y - py);
      if (d <= bestD) { bestD = d; best = [x, y]; }
    }
  return best;
}

function carvePath(
  heights: Float32Array, original: Float32Array, riverMask: Uint8Array, N: number, path: Point[], id: number,
): void {
  const W = WATER_LEVEL;
  const len = path.length;
  for (let p = 0; p < len; p++) {
    const [px, py] = path[p];
    const r = lerp(1.0, 3.2, p / (len - 1)); // widens downstream
    const localH = Math.min(VALLEY_HEIGHT_MAX, Math.max(0, sampleGrid(original, N, px, py) - W));
    const R = r + 5 + localH * 0.8; // valley width grows with ground height -> gentle banks
    const x0 = Math.max(0, Math.floor(px - R)), x1 = Math.min(N - 1, Math.ceil(px + R));
    const y0 = Math.max(0, Math.floor(py - R)), y1 = Math.min(N - 1, Math.ceil(py + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - px, y - py);
        if (d > R) continue;
        const k = y * N + x;
        let target: number;
        if (d <= r) {
          const q = d / r;
          target = W - 0.5 - 0.9 * (1 - q * q);
          if (!riverMask[k]) riverMask[k] = id;
        } else {
          target = lerp(W + 0.4, original[k], smoothstep(r, R, d));
        }
        if (target < heights[k]) heights[k] = target;
      }
    }
  }
}

/** (px, py) lies beyond the play area border on `side` (grid cells). */
function outsidePlay(play: PlayArea, side: Side, px: number, py: number): boolean {
  switch (side) {
    case 'north': return py < play.j0;
    case 'south': return py > play.j1;
    case 'west': return px < play.i0;
    case 'east': return px > play.i1;
  }
}
