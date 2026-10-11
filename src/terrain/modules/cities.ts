// Cities module: 0..2 compact built-up areas per map, in contested ground (as far from every player base as the
// land allows, leaning towards the middle of the map). Each city is a ragged disc of dry, gentle land, levelled
// a little (towns sit on fairly flat ground), with a regular street grid at a random angle. The roads module
// lays the streets first, so the base ring roads run through the cities; the buildings module fills the blocks.

import type { Rng } from '../../core/rng.ts';
import { linearScale } from '../scale.ts';
import { createNoise2D, lerp, smoothstep } from '../../core/noise.ts';
import { boxBlur, slopeField } from '../grid.ts';
import { WATER_LEVEL, type PlayArea, type Point } from '../types.ts';
import type { City } from '../buildings/types.ts';
import type { Base } from './bases.ts';
import { boxSum, summedArea } from './bases.ts';

/** Chance of a map having no / one city (else two). */
const NO_CITY = 0.3;
const ONE_CITY = 0.45;
/** City radius range, cells. */
const MIN_RADIUS = 75;
const MAX_RADIUS = 110;
/** Street block size range, cells (40..52 m between street centres: room for a building on each side). */
const MIN_BLOCK = 20;
const MAX_BLOCK = 26;
/** Radius factors tried in turn when a city doesn't fit at full size. */
const SHRINK = [1, 0.8, 0.65];
/** Cells kept clear around a base's build area. */
const BASE_MARGIN = 10;
/** Cells kept clear around a river bed. */
const RIVER_MARGIN = 3;
/** Share of the original relief kept inside a city. */
const KEEP_RELIEF = 0.3;
/** Minimum streets for a city to be worth it (fewer: no city there). */
const MIN_STREETS = 4;
/** Streets shorter than this (cells) are left out; ends stop this far inside the city edge, or at a crossing this close. */
const MIN_STREET = 8;
const STREET_END_INSET = 1.5;
const END_SNAP = 6;

/** City in grid space: what the roads and buildings modules work with. */
export interface CitySite {
  id: number;
  /** Centre cell and radius (cells). */
  x: number;
  y: number;
  radius: number;
  angle: number;
  /** Block size, cells. */
  block: number;
  /** Street grid: crossing points (grid coordinates) and streets between them (node index pairs). */
  nodes: Point[];
  streets: [number, number][];
}

export interface CityInput {
  N: number;
  cell: number;
  play: PlayArea;
  /** Modified in place: each city is levelled a little. */
  heights: Float32Array;
  riverMask: Uint8Array;
  mountain: Float32Array;
  bases: Base[];
}

export interface CityResult {
  sites: CitySite[];
  cities: City[];
  /** City id + 1 per cell inside a city, else 0. */
  mask: Uint8Array;
}

export function placeCities(input: CityInput, rng: Rng): CityResult {
  const { N, cell, play, heights, riverMask, mountain, bases } = input;
  const mask = new Uint8Array(N * N);
  const result: CityResult = { sites: [], cities: [], mask };
  const roll = rng();
  const count = roll < NO_CITY ? 0 : roll < NO_CITY + ONE_CITY ? 1 : 2;
  const noise = createNoise2D(rng);
  // Cities grow with the map (radius, so area, by the map scale); how many there are does not.
  const citySize = linearScale(play.i1 - play.i0 + 1);
  if (!count || !bases.length) return result;

  const slope = slopeField(heights, N, cell);
  const nearRiver = boxBlur(Float32Array.from(riverMask, (v) => (v ? 1 : 0)), N, RIVER_MARGIN);
  // Never inside a city: water, river banks, mountains, base areas (with a margin).
  const hard = new Uint8Array(N * N);
  for (let k = 0; k < hard.length; k++) hard[k] = heights[k] < WATER_LEVEL + 1.5 || nearRiver[k] > 0 || mountain[k] > 1.5 ? 1 : 0;
  const block = (i0: number, j0: number, i1: number, j1: number) => {
    for (let j = Math.max(0, j0); j <= Math.min(N - 1, j1); j++)
      for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) hard[j * N + i] = 1;
  };
  for (const b of bases) block(b.i0 - BASE_MARGIN, b.j0 - BASE_MARGIN, b.i1 + BASE_MARGIN, b.j1 + BASE_MARGIN);

  const ci = (play.i0 + play.i1) / 2, cj = (play.j0 + play.j1) / 2;
  const baseCells = bases.map((b) => [(b.i0 + b.i1) / 2, (b.j0 + b.j1) / 2]);
  const half = ((N - 1) * cell) / 2;

  for (let c = 0; c < count; c++) {
    // Every random value is drawn whatever happens next, so the stream stays aligned.
    const fullR = (MIN_RADIUS + rng() * (MAX_RADIUS - MIN_RADIUS)) * citySize;
    const angle = rng() * (Math.PI / 2);
    const blockSize = MIN_BLOCK + rng() * (MAX_BLOCK - MIN_BLOCK);
    const offU = (rng() - 0.5) * blockSize, offV = (rng() - 0.5) * blockSize;
    const jitter = rng();

    const ok = new Uint8Array(N * N);
    for (let k = 0; k < ok.length; k++) ok[k] = !hard[k] && slope[k] < 0.3 ? 1 : 0;
    const okSat = summedArea(ok, N);
    const hardSat = summedArea(hard, N);
    const id = result.sites.length;
    let found: { i: number; j: number; R: number; shape: Uint8Array; streets: ReturnType<typeof streetGrid> } | null = null;
    for (const f of SHRINK) {
      const R = Math.round(fullR * f);
      const best = bestSite(R);
      if (!best) continue;
      // Ragged disc of usable land, connected to the centre.
      const shape = new Uint8Array(N * N);
      const x0 = Math.max(0, best.i - 2 * R), x1 = Math.min(N - 1, best.i + 2 * R);
      const y0 = Math.max(0, best.j - 2 * R), y1 = Math.min(N - 1, best.j + 2 * R);
      for (let j = y0; j <= y1; j++)
        for (let i = x0; i <= x1; i++) {
          const k = j * N + i;
          const reach = R * (1 + 0.22 * noise(i * 0.06 + 100 * (id + 1), j * 0.06));
          if (!hard[k] && slope[k] < 0.4 && Math.hypot(i - best.i, j - best.j) < reach) shape[k] = 1;
        }
      keepConnected(shape, N, best.j * N + best.i);
      const streets = streetGrid(shape, N, best.i, best.j, R, angle, blockSize, offU, offV);
      if (streets.streets.length >= MIN_STREETS) {
        found = { i: best.i, j: best.j, R, shape, streets };
        break;
      }
    }
    if (!found) continue;
    const { R, shape, streets } = found;
    const best = found;

    /** Highest scoring centre for a city of radius R, or null. */
    function bestSite(R: number): { i: number; j: number } | null {
      const inner = Math.round(R * 0.3);
      const area = (2 * R + 1) ** 2;
      let best: { i: number; j: number; score: number } | null = null;
      for (let j = play.j0 + R + 4; j <= play.j1 - R - 4; j += 3) {
        for (let i = play.i0 + R + 4; i <= play.i1 - R - 4; i += 3) {
          if (boxSum(hardSat, N, i - inner, j - inner, i + inner, j + inner) > 0) continue;
          if (boxSum(okSat, N, i - R, j - R, i + R, j + R) / area < 0.55) continue;
          // Contested ground: far from the nearest base, a little towards the map centre.
          const fromBases = Math.min(...baseCells.map(([x, y]) => Math.hypot(i - x, j - y)));
          const fromOthers = result.sites.length ? Math.min(...result.sites.map((s) => Math.hypot(i - s.x, j - s.y) - s.radius)) : Infinity;
          if (fromOthers < R + 20) continue;
          const score = fromBases - 0.35 * Math.hypot(i - ci, j - cj) + Math.min(fromOthers, 80) * 0.3
            + noise(i * 0.05 + jitter * 50, j * 0.05) * 6;
          if (!best || score > best.score) best = { i, j, score };
        }
      }
      return best;
    }

    for (let k = 0; k < shape.length; k++) if (shape[k]) mask[k] = id + 1;
    const y = levelCity(heights, N, riverMask, shape);
    result.sites.push({ id, x: best.i, y: best.j, radius: R, angle, block: blockSize, ...streets });
    result.cities.push({
      id,
      x: best.i * cell - half,
      y,
      z: best.j * cell - half,
      radius: R * cell,
      angle,
      block: blockSize * cell,
    });
    // The next city keeps well away from this one.
    block(best.i - R - 8, best.j - R - 8, best.i + R + 8, best.j + R + 8);
  }
  return result;
}

/** Clears every cell of `shape` not 4-connected to `start`. */
function keepConnected(shape: Uint8Array, N: number, start: number): void {
  if (!shape[start]) {
    shape.fill(0);
    return;
  }
  const seen = new Uint8Array(N * N);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % N, y = (k - x) / N;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const n = ny * N + nx;
      if (shape[n] && !seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  for (let k = 0; k < shape.length; k++) if (!seen[k]) shape[k] = 0;
}

/**
 * Regular street grid over the city shape: two families of parallel lines `block` apart (rotated by `angle`), each
 * clipped to the shape, so streets run out to the town's edge. Nodes sit where streets cross and at street ends
 * (an end close to a crossing stops there instead). Only the largest connected piece is kept.
 */
function streetGrid(
  shape: Uint8Array, N: number, cx: number, cy: number, R: number, angle: number, block: number, offU: number, offV: number,
): { nodes: Point[]; streets: [number, number][] } {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const inside = ([x, y]: Point) => {
    const i = Math.round(x), j = Math.round(y);
    return i >= 0 && j >= 0 && i < N && j < N && shape[j * N + i] === 1;
  };
  const pt = (u: number, v: number): Point => [cx + u * ux - v * uy, cy + u * uy + v * ux];
  const n = Math.ceil((1.6 * R) / block);
  const side = 2 * n + 1;
  const L = 1.8 * R;
  /** Node id of crossing (a, b); street ends get ids after all crossings. */
  const crossing = (a: number, b: number) => (b + n) * side + (a + n);
  let nextEnd = side * side;
  const posOf = new Map<number, Point>();
  const links: [number, number][] = [];

  for (const along of [0, 1]) {
    for (let line = -n; line <= n; line++) {
      const fixed = (along ? offU : offV) + line * block;
      const P = (t: number) => (along ? pt(fixed, t) : pt(t, fixed));
      // Inside runs along the line.
      const runs: [number, number][] = [];
      let start: number | null = null;
      for (let t = -L; t <= L; t += 0.5) {
        const ins = inside(P(t));
        if (ins && start === null) start = t;
        if (!ins && start !== null) {
          runs.push([start, t - 0.5]);
          start = null;
        }
      }
      if (start !== null) runs.push([start, L]);
      for (const [t0, t1] of runs) {
        const e0 = t0 + STREET_END_INSET, e1 = t1 - STREET_END_INSET;
        if (e1 - e0 < MIN_STREET) continue;
        const off = along ? offV : offU;
        const stops: { t: number; id: number }[] = [];
        for (let k = -n; k <= n; k++) {
          const t = off + k * block;
          if (t >= e0 && t <= e1) stops.push({ t, id: along ? crossing(line, k) : crossing(k, line) });
        }
        if (!stops.length || stops[0].t - e0 > END_SNAP) stops.unshift({ t: e0, id: nextEnd++ });
        if (e1 - stops[stops.length - 1].t > END_SNAP) stops.push({ t: e1, id: nextEnd++ });
        for (const st of stops) posOf.set(st.id, P(st.t));
        for (let i = 1; i < stops.length; i++) links.push([stops[i - 1].id, stops[i].id]);
      }
    }
  }

  // Largest connected piece (union-find over node ids).
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  for (const [p, q] of links) parent.set(find(p), find(q));
  const size = new Map<number, number>();
  for (const [p] of links) size.set(find(p), (size.get(find(p)) ?? 0) + 1);
  let main = -1, mainSize = 0;
  for (const [root, s] of size) if (s > mainSize || (s === mainSize && root < main)) [main, mainSize] = [root, s];

  const nodeOf = new Map<number, number>();
  const nodes: Point[] = [];
  const streets: [number, number][] = [];
  const node = (id: number): number => {
    let k = nodeOf.get(id);
    if (k === undefined) {
      nodeOf.set(id, (k = nodes.length));
      nodes.push(posOf.get(id)!);
    }
    return k;
  };
  for (const [p, q] of links) if (find(p) === main) streets.push([node(p), node(q)]);
  return { nodes, streets };
}

/** Levels the city towards its mean height (keeping a little relief), blending out over a few cells. Returns the mean. */
function levelCity(heights: Float32Array, N: number, riverMask: Uint8Array, shape: Uint8Array): number {
  let sum = 0, count = 0;
  for (let k = 0; k < shape.length; k++) if (shape[k]) { sum += heights[k]; count++; }
  const target = sum / Math.max(1, count);
  const soft = boxBlur(Float32Array.from(shape), N, 3);
  for (let k = 0; k < heights.length; k++) {
    const w = shape[k] ? 1 : smoothstep(0, 0.5, soft[k]);
    if (w <= 0 || riverMask[k] || heights[k] < WATER_LEVEL + 0.25) continue;
    heights[k] = lerp(heights[k], target + (heights[k] - target) * KEEP_RELIEF, w);
  }
  return target;
}
