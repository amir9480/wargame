// Buildings module: houses, blocks of flats, offices, shops, gas stations, warehouses and farms along the roads
// (never the railway). Inside a city the street fronts are lined densely, with taller buildings towards the
// centre; elsewhere buildings gather in hamlets where a settlement noise field is high, with lone farms between.
// Every building faces its road. Its shape comes from its own seed (buildings/spec.ts), drawn from this module's
// stream, so the whole map stays a function of the map seed. The ground under each footprint is levelled into a
// flat pad (roads, base areas and water are left alone).

import { hash32, type Rng } from '../../core/rng.ts';
import { lerp, smoothstep, type Noise2D } from '../../core/noise.ts';
import { boxBlur } from '../grid.ts';
import { WATER_LEVEL } from '../types.ts';
import { linearScale } from '../scale.ts';
import { buildingSpec, type BuildingSpec } from '../buildings/spec.ts';
import { planCranes } from '../buildings/crane.ts';
import type { Building, BuildingType, ParkingLot } from '../buildings/types.ts';
import type { RoadEdge, RoadNetwork } from './roads/types.ts';
import type { Base } from './bases.ts';
import type { CitySite } from './cities.ts';

export interface BuildingInput {
  N: number;
  cell: number;
  /** Modified in place: a flat pad under every building. */
  heights: Float32Array;
  riverMask: Uint8Array;
  /** 1 on road / rail / bridge cells. */
  roadMask: Uint8Array;
  /** 1 on cells levelled to a road surface / junction pad (incl. town sidewalks): pads never tilt them. */
  roadLevel: Uint8Array;
  mountain: Float32Array;
  bases: Base[];
  roads: RoadNetwork;
  cities: CitySite[];
  /** City id + 1 per cell. */
  cityMask: Uint8Array;
  /** Play area side in cells: bigger maps get a denser countryside (see terrain/scale.ts). */
  size: number;
}

export interface BuildingResult {
  buildings: Building[];
  parking: ParkingLot[];
  /** 1 on cells under a building / car park or its yard (ground looks worn). */
  occupied: Uint8Array;
  /** 1 where rocks and trees keep off: footprints plus a clearing (wide around halls and farms). */
  clearing: Uint8Array;
}

/** Gap (m) between a building and its road's edge. */
// The road mask reaches 2 m past the road edge and footprints are tested 1 m beyond their walls: at least 3 m.
const CITY_SETBACK = [3.2, 4.5];
const RURAL_SETBACK = [3.5, 8];
const GAS_SETBACK = 3.2;
/** Lots start this far (m, along the road) from a road node; farther out of town (junction pads, clear corners). */
const CITY_NODE_CLEAR = 4;
const RURAL_NODE_CLEAR = 16;
const GAS_NODE_CLEAR = 8;
/** Steepest ground under a footprint (m between its lowest and highest cell) before levelling. */
const MAX_RELIEF = 3;
/** Pads blend into the surrounding ground over this distance (m). */
const PAD_BLEND = 4;
/** Clear yard (m) kept around each building: no other building, rock or tree. */
const YARD = 1;
/** Clearing (m) kept free of trees and rocks around each kind of building, so nothing stands in a wood. */
const CLEARING: Record<BuildingType, number> = {
  villa: 5, apartment: 4, office: 4, market: 5, gas: 7, warehouse: 12, farmhouse: 8, barn: 8,
};
/** Town car parks: chance per free lot, and after a market / office; bay width and lot depth (m). */
const PARKING_CHANCE = 0.2;
const PARKING_AFTER = 0.75;
const BAY = 2.6;
const PARKING_DEPTH = 16;
/** Out of town, at most this many gas stations per map. */
const RURAL_GAS = 2;
/** Chance a building was left behind (abandoned): base share + up to this much more where the decay noise is high. */
const ABANDON_CITY = 0.07;
const ABANDON_RURAL = 0.18;
const ABANDON_NOISE = 0.3;
/** Share of those left as unfinished construction sites instead (decided by a hash: no extra draw from the stream). */
const CONSTRUCTION_SHARE = 0.5;

/** Weighted type pick. */
type Weights = [BuildingType, number][];
const CITY_CORE: Weights = [['office', 0.4], ['apartment', 0.45], ['market', 0.15]];
const CITY_MID: Weights = [['apartment', 0.45], ['market', 0.2], ['villa', 0.25], ['office', 0.1]];
const CITY_RIM: Weights = [['villa', 0.5], ['warehouse', 0.2], ['apartment', 0.2], ['market', 0.1]];
const RURAL_DIRT: Weights = [['farmhouse', 0.5], ['villa', 0.42], ['warehouse', 0.08]];
const RURAL_ASPHALT: Weights = [['villa', 0.45], ['farmhouse', 0.2], ['warehouse', 0.14], ['apartment', 0.1], ['market', 0.06], ['gas', 0.05]];

/** Anything with a levelled footprint (buildings, car parks). */
interface Footprint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  width: number;
  depth: number;
}

interface Rect {
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
}

export function placeBuildings(input: BuildingInput, rng: Rng, noise: Noise2D): BuildingResult {
  const { N, cell, heights, riverMask, roadMask, mountain, bases, roads, cities, cityMask } = input;
  const half = ((N - 1) * cell) / 2;
  const toGrid = (v: number) => (v + half) / cell;

  // Cells no building may cover: roads, water and river banks, mountains, base areas, the grid border.
  const blocked = new Uint8Array(N * N);
  const nearRiver = boxBlur(Float32Array.from(riverMask, (v) => (v ? 1 : 0)), N, 2);
  for (let k = 0; k < blocked.length; k++) {
    const x = k % N, y = (k - x) / N;
    if (roadMask[k] || nearRiver[k] > 0 || heights[k] < WATER_LEVEL + 1 || mountain[k] > 2.5 || x < 3 || y < 3 || x > N - 4 || y > N - 4) blocked[k] = 1;
  }
  const keep = new Uint8Array(N * N);
  for (const b of bases)
    for (let j = Math.max(0, b.j0 - 4); j <= Math.min(N - 1, b.j1 + 4); j++)
      for (let i = Math.max(0, b.i0 - 4); i <= Math.min(N - 1, b.i1 + 4); i++) {
        blocked[j * N + i] = 1;
        if (i >= b.i0 && i <= b.i1 && j >= b.j0 && j <= b.j1) keep[j * N + i] = 1;
      }

  /** Grid cells whose centre lies inside the rectangle grown by `margin` (m). */
  const cellsOf = ({ x, z, yaw, w, d }: Rect, margin = 0): number[] => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hw = w / 2 + margin, hd = d / 2 + margin;
    const r = Math.hypot(hw, hd) / cell;
    const gx = toGrid(x), gz = toGrid(z);
    const out: number[] = [];
    for (let j = Math.max(0, Math.floor(gz - r)); j <= Math.min(N - 1, Math.ceil(gz + r)); j++)
      for (let i = Math.max(0, Math.floor(gx - r)); i <= Math.min(N - 1, Math.ceil(gx + r)); i++) {
        const dx = i * cell - half - x, dz = j * cell - half - z;
        // Local frame: X = (cos, -sin), Z = (sin, cos).
        if (Math.abs(dx * c - dz * s) <= hw && Math.abs(dx * s + dz * c) <= hd) out.push(j * N + i);
      }
    return out;
  };

  // Placed footprints in 32 m buckets, for exact overlap tests (the grid is too coarse for close neighbours).
  const placed: Rect[] = [];
  const buckets = new Map<number, number[]>();
  const bucketKey = (bx: number, bz: number) => bx * 4096 + bz;
  const overlaps = (r: Rect, gap: number): boolean => {
    const reach = Math.hypot(r.w, r.d) / 2 + 30;
    for (let bz = Math.floor((r.z - reach) / 32); bz <= Math.floor((r.z + reach) / 32); bz++)
      for (let bx = Math.floor((r.x - reach) / 32); bx <= Math.floor((r.x + reach) / 32); bx++)
        for (const i of buckets.get(bucketKey(bx, bz)) ?? []) if (rectsOverlap(r, placed[i], gap)) return true;
    return false;
  };

  const buildings: Building[] = [];
  const parking: ParkingLot[] = [];
  const occupied = new Uint8Array(N * N);
  const clearing = new Uint8Array(N * N);

  /** Takes `rect` if it is free (no blocked cell, not too steep, `gap` from everything placed); clears `clear` m around it. */
  const claim = (rect: Rect, gap: number, clear: number): boolean => {
    const cells = cellsOf(rect);
    if (!cells.length) return false;
    // Blocked cells are tested a little beyond the walls: cell centres are 2 m apart.
    for (const k of cellsOf(rect, cell / 2)) if (blocked[k]) return false;
    let lo = Infinity, hi = -Infinity;
    for (const k of cells) {
      lo = Math.min(lo, heights[k]);
      hi = Math.max(hi, heights[k]);
    }
    // Neighbours are spaced exactly `gap` apart along a street: test a little less, so they pass.
    if (hi - lo > MAX_RELIEF || overlaps(rect, gap * 0.8)) return false;
    const key = bucketKey(Math.floor(rect.x / 32), Math.floor(rect.z / 32));
    buckets.set(key, [...(buckets.get(key) ?? []), placed.length]);
    placed.push(rect);
    for (const k of cellsOf(rect, YARD)) occupied[k] = 1;
    for (const k of cellsOf(rect, clear)) clearing[k] = 1;
    return true;
  };

  /** Tries to put a building of `spec` at `rect`; on success it is recorded and returned. */
  const tryPlace = (spec: BuildingSpec, rect: Rect, city: number, gap: number): Building | null => {
    if (!claim(rect, gap, CLEARING[spec.type])) return null;
    const id = buildings.length;
    const decay = Math.max(0, noise(rect.x / 150 + 37.1, rect.z / 150 - 11.3));
    const abandoned = rng() < (city >= 0 ? ABANDON_CITY : ABANDON_RURAL) + ABANDON_NOISE * decay;
    const b: Building = {
      id,
      seed: spec.seed,
      type: spec.type,
      x: rect.x,
      y: 0, // set when the pads are levelled
      z: rect.z,
      yaw: rect.yaw,
      width: spec.width,
      depth: spec.depth,
      height: spec.height,
      floors: spec.floors,
      condition: !abandoned ? 'intact' : hash32(spec.seed, 0xc0b5) / 4294967296 < CONSTRUCTION_SHARE ? 'construction' : 'abandoned',
      city,
      crane: null, // planned once every building stands (planCranes)
    };
    buildings.push(b);
    return b;
  };

  const newSpec = (type: BuildingType) => buildingSpec((rng() * 4294967296) >>> 0, type);
  const pick = (weights: Weights): BuildingType => {
    let t = rng() * weights.reduce((s, [, w]) => s + w, 0);
    for (const [type, w] of weights) if ((t -= w) < 0) return type;
    return weights[weights.length - 1][0];
  };
  const cityAt = (x: number, z: number): number => {
    const i = Math.round(toGrid(x)), j = Math.round(toGrid(z));
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : cityMask[j * N + i] - 1;
  };
  /** A lot belongs to town `city` if its centre is in the city or just beyond its ragged edge (not in another city). */
  const inTown = (rect: Rect, city: number): boolean => {
    const at = cityAt(rect.x, rect.z);
    if (at === city) return true;
    const site = cities[city];
    return at === -1 && Math.hypot(toGrid(rect.x) - site.x, toGrid(rect.z) - site.y) < site.radius * 1.2;
  };
  /** Car park of `bays` bays per row facing the road at `rect`, if it is free. */
  const tryParking = (rect: Rect, bays: number, city: number, gap: number): boolean => {
    if (!claim(rect, gap, 2)) return false;
    parking.push({ id: parking.length, x: rect.x, y: 0, z: rect.z, yaw: rect.yaw, width: rect.w, depth: rect.d, bays, city, seed: (rng() * 4294967296) >>> 0 });
    return true;
  };
  /** Lot facing the road at arc `s` of `walk`, on `side`: building centre `setback` m beyond the road edge. */
  const lot = (walk: EdgeWalk, s: number, side: number, spec: { width: number; depth: number }, setback: number, jitter = 0): Rect => {
    const p = walk.at(s);
    const nx = -p.tz * side, nz = p.tx * side; // from the road towards the building
    const off = walk.edge.width / 2 + setback + spec.depth / 2;
    return { x: p.x + nx * off, z: p.z + nz * off, yaw: Math.atan2(-nx, -nz) + jitter, w: spec.width, d: spec.depth };
  };

  const edges = roads.edges.filter((e) => e.type !== 'rail');
  const walks = edges.map((e) => new EdgeWalk(e));

  // 1. One gas station on a road leaving each city, a little outside it.
  for (const site of cities) {
    let done = false;
    for (const walk of walks) {
      const { total } = walk;
      for (let s = 2; s < total - 2 && !done; s += 2) {
        const p = walk.at(s), q = walk.at(s - 2);
        // Where the road crosses the city edge (leaving it along the edge's direction, or entering it).
        const here = cityAt(p.x, p.z), before = cityAt(q.x, q.z);
        const leaving = here === -1 && before === site.id, entering = here === site.id && before === -1;
        if (!leaving && !entering) continue;
        const spec = newSpec('gas');
        for (const out of [6, 14, 24, 36, 50, 65]) {
          const at = leaving ? s + out + spec.width / 2 : s - 2 - out - spec.width / 2;
          if (at - spec.width / 2 < GAS_NODE_CLEAR || at + spec.width / 2 > total - GAS_NODE_CLEAR || walk.blockedAt(at, spec.width / 2)) continue;
          for (const side of [1, -1]) {
            if (tryPlace(spec, lot(walk, at, side, spec, GAS_SETBACK), site.id, 2)) {
              done = true;
              break;
            }
          }
          if (done) break;
        }
      }
      if (done) break;
    }
  }

  // 2. Street fronts, city and country, edge by edge, each side in turn.
  let ruralGas = 0;
  // Bigger maps: more farms and hamlets along the country roads (1 up to the reference map).
  const ruralDensity = linearScale(input.size);
  for (const walk of walks) {
    const { edge, total } = walk;
    for (const side of [1, -1]) {
      let s = CITY_NODE_CLEAR;
      let wantParking = false;
      while (s < total - CITY_NODE_CLEAR) {
        const p = walk.at(s);
        const city = cityAt(p.x, p.z);
        if (city >= 0) {
          // Town: dense lots, taller buildings towards the centre.
          const site = cities[city];
          const r = Math.hypot(toGrid(p.x) - site.x, toGrid(p.z) - site.y) / site.radius;
          const weights = r < 0.35 ? CITY_CORE : r < 0.7 ? CITY_MID : CITY_RIM;
          const setback = CITY_SETBACK[0] + rng() * (CITY_SETBACK[1] - CITY_SETBACK[0]);
          const gap = 1 + rng() * 2;
          // Now and then a car park (most often beside a market or an office).
          if (rng() < PARKING_CHANCE || wantParking) {
            wantParking = false;
            const bays = 6 + Math.floor(rng() * 7);
            const size = { width: bays * BAY + 1, depth: PARKING_DEPTH };
            const at = s + size.width / 2;
            if (at + size.width / 2 <= total - CITY_NODE_CLEAR && !walk.blockedAt(at, size.width / 2)) {
              const rect = lot(walk, at, side, size, setback);
              if (inTown(rect, city) && tryParking(rect, bays, city, gap)) {
                s += size.width + gap;
                continue;
              }
            }
          }
          // A few tries: a big building may not fit the lot where a smaller one does (the last try is a house).
          let width = 0;
          for (let attempt = 0; attempt < 4 && !width; attempt++) {
            const spec = newSpec(attempt < 3 ? pick(weights) : 'villa');
            const at = s + spec.width / 2;
            if (at + spec.width / 2 > total - CITY_NODE_CLEAR || walk.blockedAt(at, spec.width / 2)) continue;
            const rect = lot(walk, at, side, spec, setback);
            if (inTown(rect, city) && tryPlace(spec, rect, city, gap)) {
              width = spec.width;
              wantParking = (spec.type === 'market' || spec.type === 'office') && rng() < PARKING_AFTER;
            }
          }
          s += width ? width + gap : 3;
          continue;
        }

        // Country: hamlets where the settlement field is high, lone farms elsewhere.
        const dens = settlement(noise, p.x, p.z);
        const chance = Math.min(0.95, (dens > 0.58 ? 0.7 : dens > 0.45 ? 0.25 : 0.04) * ruralDensity);
        if (s < RURAL_NODE_CLEAR || rng() >= chance) {
          s += 8;
          continue;
        }
        let type = pick(edge.type === 'asphalt' ? RURAL_ASPHALT : RURAL_DIRT);
        if (type === 'gas' && ruralGas >= RURAL_GAS) type = 'villa';
        const spec = newSpec(type);
        const at = s + spec.width / 2;
        const setback = type === 'gas' ? GAS_SETBACK : RURAL_SETBACK[0] + rng() * (RURAL_SETBACK[1] - RURAL_SETBACK[0]);
        const jitter = type === 'gas' ? 0 : (rng() - 0.5) * 0.12;
        const gap = dens > 0.58 ? 4 + rng() * 8 : (30 + rng() * 70) / ruralDensity;
        if (at + spec.width / 2 > total - RURAL_NODE_CLEAR || walk.blockedAt(at, spec.width / 2)) {
          s += 6;
          continue;
        }
        const rect = lot(walk, at, side, spec, setback, jitter);
        const b = cityAt(rect.x, rect.z) === -1 ? tryPlace(spec, rect, -1, 3) : null;
        if (!b) {
          s += 6;
          continue;
        }
        if (type === 'gas') ruralGas++;
        if (type === 'farmhouse') placeBarn(rect);
        s += spec.width + gap;
      }
    }
  }

  /** A barn beside or behind a farmhouse, same orientation. */
  function placeBarn(house: Rect): void {
    const spec = newSpec('barn');
    const c = Math.cos(house.yaw), s = Math.sin(house.yaw);
    const alongX = c, alongZ = -s; // local +X
    const backX = -s, backZ = -c; // local -Z (away from the road)
    const side = (house.w + spec.width) / 2 + 5;
    const back = (house.d + spec.depth) / 2 + 5;
    const spots: [number, number][] = [[alongX * side, alongZ * side], [-alongX * side, -alongZ * side], [backX * back, backZ * back]];
    const first = Math.floor(rng() * spots.length);
    for (let n = 0; n < spots.length; n++) {
      const [dx, dz] = spots[(first + n) % spots.length];
      if (tryPlace(spec, { x: house.x + dx, z: house.z + dz, yaw: house.yaw, w: spec.width, d: spec.depth }, -1, 3)) return;
    }
  }

  levelPads(input, [...buildings, ...parking], cellsOf, keep);
  planCranes(buildings, { heights, N, cell });
  return { buildings, parking, occupied, clearing };
}

/** 0..1 settlement density: hamlets where high (patches a few hundred metres across). */
function settlement(noise: Noise2D, x: number, z: number): number {
  return 0.5 + 0.35 * noise(x / 230 + 71.3, z / 230 - 19.7) + 0.15 * noise(x / 70 - 5.1, z / 70 + 44.2);
}

/** Flattens the ground under every footprint (plus its yard) to the footprint's mean height, blended out over PAD_BLEND m. */
function levelPads(
  { N, cell, heights, riverMask, roadLevel }: BuildingInput, buildings: Footprint[],
  cellsOf: (r: Rect, margin?: number) => number[], keep: Uint8Array,
): void {
  const half = ((N - 1) * cell) / 2;
  const padded = new Uint8Array(N * N);
  const fixed = (k: number) => roadLevel[k] || keep[k] || riverMask[k] || heights[k] < WATER_LEVEL + 0.25;
  for (const b of buildings) {
    const rect = { x: b.x, z: b.z, yaw: b.yaw, w: b.width, d: b.depth };
    const core = cellsOf(rect);
    let sum = 0;
    for (const k of core) sum += heights[k];
    const target = sum / core.length;
    b.y = target;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    for (const k of cellsOf(rect, YARD + PAD_BLEND)) {
      if (fixed(k) || padded[k]) continue;
      const x = k % N, j = (k - x) / N;
      const dx = x * cell - half - b.x, dz = j * cell - half - b.z;
      const lx = Math.abs(dx * c - dz * s) - b.width / 2, lz = Math.abs(dx * s + dz * c) - b.depth / 2;
      const ox = Math.max(0, lx - YARD), oz = Math.max(0, lz - YARD);
      const w = 1 - smoothstep(0, PAD_BLEND, Math.hypot(ox, oz));
      if (w <= 0) continue;
      heights[k] = lerp(heights[k], target, w);
      if (lx <= 0 && lz <= 0) padded[k] = 1; // under the building: later pads never tilt it
    }
  }
}

/** Two rectangles closer than `gap` (separating axis test on the rectangles grown by gap / 2). */
function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  const axes = [a.yaw, b.yaw].flatMap((yaw) => [[Math.cos(yaw), -Math.sin(yaw)], [Math.sin(yaw), Math.cos(yaw)]]);
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ax, az] of axes) {
    const proj = (r: Rect) => {
      const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
      return Math.abs((c * ax - s * az) * (r.w / 2 + gap / 2)) + Math.abs((s * ax + c * az) * (r.d / 2 + gap / 2));
    };
    if (Math.abs(dx * ax + dz * az) > proj(a) + proj(b)) return false;
  }
  return true;
}

/** Arc-length walk along a road edge (world units). */
class EdgeWalk {
  readonly edge: RoadEdge;
  readonly total: number;
  private arcs: number[];

  constructor(edge: RoadEdge) {
    this.edge = edge;
    const pts = edge.points;
    this.arcs = [0];
    for (let i = 1; i < pts.length; i++) this.arcs.push(this.arcs[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    this.total = this.arcs[this.arcs.length - 1];
  }

  private seg(s: number): number {
    const a = this.arcs;
    let lo = 0, hi = a.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** Point and unit tangent at arc length `s`. */
  at(s: number): { x: number; z: number; tx: number; tz: number } {
    const pts = this.edge.points;
    const i = this.seg(s);
    const f = Math.min(1, Math.max(0, (s - this.arcs[i]) / Math.max(1e-6, this.arcs[i + 1] - this.arcs[i])));
    const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)];
    const p0 = pts[Math.max(0, i - 2)], p1 = pts[Math.min(pts.length - 1, i + 3)];
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, tx: (p1.x - p0.x) / len, tz: (p1.z - p0.z) / len };
  }

  /** Within `reach` (arc length) of `s` the road is on or next to a bridge. */
  blockedAt(s: number, reach: number): boolean {
    const i0 = this.seg(Math.max(0, s - reach - 8)), i1 = this.seg(Math.min(this.total, s + reach + 8)) + 1;
    return this.edge.bridges.some((b) => b.start <= i1 && b.end >= i0);
  }
}
