// Power module: power plants, substations, high-voltage pylon lines and roadside utility poles.
//
//   sites   -> every city needs power: at least one power plant on dry gentle ground some way out (a map without a city has a plant
//              half of the time), and one substation on each city's edge, on the side facing the plant. Both stand on a levelled
//              fenced pad and face the nearest road (yaw is a multiple of 90 degrees).
//   lines   -> the sites are joined by high-voltage lines (a minimum spanning tree, plant first): straight runs of big lattice
//              pylons about `PYLON_SPAN` apart, each nudged along the line to the nearest ground that is dry, free and not steep.
//   poles   -> a medium-voltage feed leaves every substation (or a plant that has none) for the nearest road, then runs along the
//              roads as wooden / concrete utility poles to every rural building (and every base) within reach. Towns are served
//              underground (no poles inside `TOWN_REACH`). Poles are wired in a tree (`links`).
//
// Plants, substations and pylon spots go in `clearing` (rocks, trees keep off) and are levelled; everything is pure data in world
// units, so gameplay / AI can query it. It has its own random stream (seeds.ts); poles and pylon line heights use hashes only.

import type { Rng } from '../../core/rng.ts';
import { hash32 } from '../../core/rng.ts';
import { linearScale } from '../scale.ts';
import { sampleGrid, slopeField } from '../grid.ts';
import { townAt, TOWN_REACH } from '../urban.ts';
import type { Building, City } from '../buildings/types.ts';
import type { Base } from './bases.ts';
import type { RoadEdge, RoadNetwork } from './roads/types.ts';
import { WATER_LEVEL, type PlayArea, type Side } from '../types.ts';

export type PowerSiteKind = 'plant' | 'substation';

/**
 * A power plant (coal / gas fired: turbine hall, boiler house, stacks, cooling towers, switchyard) or a substation (fenced yard
 * with transformers and a gantry). The fenced pad is `width` (local X) by `depth` (local Z) metres, levelled; the front (local +Z)
 * points along (sin yaw, cos yaw) in world XZ, the same convention as buildings. The high-voltage lines end at the gantry
 * (see `siteGantry`).
 */
export interface PowerSite {
  id: number;
  kind: PowerSiteKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  width: number;
  depth: number;
  /** Seeds the look (render side). */
  seed: number;
  /** Substation: the city it serves. Plant: the city it was sited for (-1 if none). */
  city: number;
  /** Plant only: chimney stacks (1..2) and hyperbolic cooling towers (0..2). */
  stacks: number;
  coolers: number;
  /** Index into `PowerGrid.poles` of the first pole of the site's medium-voltage feed, or -1 (the site feeds no poles). */
  feeder: number;
}

/** A high-voltage pylon (lattice tower with three cross-arms, two circuits). The arms run along local X, the line along local +Z. */
export interface Pylon {
  x: number;
  y: number;
  z: number;
  /** Heading of the line at the pylon: it runs along (sin yaw, cos yaw). */
  yaw: number;
  /** Height of the tower above its foot (the earth wire peak is `PEAK` above it). */
  height: number;
}

/** A high-voltage line between two sites: pylons from the first site's gantry to the second's. */
export interface PowerLine {
  id: number;
  /** Site ids. */
  /** Site id, or -1 for an import line that starts at the map edge on a mountain range (no gantry there). */
  a: number;
  b: number;
  pylons: Pylon[];
}

/** A utility pole beside a road (or on a feeder line). The cross-arm runs along local X, the line along local +Z. */
export interface UtilityPole {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Pole height above its foot (m). */
  height: number;
  /** Road edge it stands along, or -1 on a feeder. */
  edge: number;
  /** Carries a pole-mounted transformer (a building is served from here). */
  transformer: boolean;
  /** Seeds wood / concrete and small details (render side). */
  seed: number;
}

export interface PowerGrid {
  sites: PowerSite[];
  lines: PowerLine[];
  poles: UtilityPole[];
  /** Wired pole pairs (indices into `poles`); also the feeds from the sites' gantries via `PowerSite.feeder`. */
  links: [number, number][];
}

export interface PowerInput {
  N: number;
  cell: number;
  play: PlayArea;
  heights: Float32Array;
  mountain: Float32Array;
  riverMask: Uint8Array;
  streamMask: Uint8Array;
  roadMask: Uint8Array;
  /** Cells that are taken (roads, base areas, towns, buildings and their yards, landmarks). */
  clear: Uint8Array;
  roads: RoadNetwork;
  buildings: Building[];
  cities: City[];
  bases: Base[];
  /** Lighthouses and radio towers (foot positions) that get a pole feed. */
  landmarks: { x: number; z: number }[];
  /** Land edges of the grid closed by a mountain range: high-voltage lines come in over them. */
  mountainSides: Side[];
}

export interface PowerResult {
  grid: PowerGrid;
  /** Cells rocks and trees keep off (site pads, pylon feet, poles). */
  clearing: Uint8Array;
}

/** Height of the earth wire peak above a pylon's top (m), and the cross-arm layout (heights as shares of `height`, half lengths m). */
export const PYLON_PEAK = 3;
export const PYLON_ARMS: readonly { at: number; half: number }[] = [
  { at: 0.64, half: 4.4 },
  { at: 0.8, half: 5.2 },
  { at: 0.94, half: 3.8 },
];
/** Insulator string length (m): conductors hang this far below the arm. */
export const INSULATOR = 2.4;
/** Utility pole conductors: local X offsets and heights below the top (m). */
export const POLE_SLOTS: readonly { x: number; dy: number }[] = [
  { x: -1.0, dy: -0.1 },
  { x: 0, dy: 0.35 },
  { x: 1.0, dy: -0.1 },
];

/** Fenced pad sizes (m): plants and substations. */
export const PLANT_SIZE = { width: 64, depth: 48 };
export const SUBSTATION_SIZE = { width: 24, depth: 18 };

/** How much smaller than the standard pad a site is (1 = full size; sites shrink on tight land). */
export function siteScale(site: PowerSite): number {
  return site.width / (site.kind === 'plant' ? PLANT_SIZE.width : SUBSTATION_SIZE.width);
}

/** Gantry (where the high-voltage line ends) in a site's local frame: two attach points at height `y` (the posts scale with the pad). */
export function siteGantry(site: PowerSite): { x: number; y: number; z: number }[] {
  const plant = site.kind === 'plant';
  const k = siteScale(site);
  const x = (plant ? 5.5 : 5) * k, y = plant ? 11 : 9, z = (plant ? 12 : 3) * k;
  const cx = (plant ? -16 : 0) * k;
  return [{ x: cx - x, y, z }, { x: cx + x, y, z }];
}

/** Local -> world position for a point in a site's frame. */
export function siteToWorld(site: PowerSite, lx: number, ly: number, lz: number): [number, number, number] {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  return [site.x + lx * c + lz * s, site.y + ly, site.z - lx * s + lz * c];
}

/** Conductor attach points of a pylon in world space: the six conductors (arm, side) and the earth wire peak. */
export function pylonAttach(p: Pylon): [number, number, number][] {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const at = (lx: number, ly: number): [number, number, number] => [p.x + lx * c, p.y + ly, p.z - lx * s];
  const out: [number, number, number][] = [];
  for (const arm of PYLON_ARMS) for (const side of [-1, 1]) out.push(at(side * arm.half, p.height * arm.at - INSULATOR));
  out.push(at(0, p.height + PYLON_PEAK));
  return out;
}

const frac = (seed: number, salt: number) => hash32(seed, salt) / 4294967296;

// ---------------------------------------------------------------------------------------------------------------------
// Tuning

/** Cells a site keeps clear round its pad (also the width of the levelled blend). */
const SITE_MARGIN = 3;
/** Slope limits tried in turn when looking for a site (1 - normal.y; 0.07 is about 21 degrees). */
const SLOPE_TIERS = [0.05, 0.08, 0.13, 0.22, 0.4];
/** Pad sizes tried in turn, as shares of `PLANT_SIZE` / `SUBSTATION_SIZE` (the models scale with their pad). */
const SITE_SCALES = [1, 0.8, 0.65, 0.5, 0.4];
/** Cells from the play area border no site is put in. */
const EDGE_INSET = 6;
/** Ground height (m) a site pad must at least have (not on the beach). */
const MIN_HEIGHT = 1.2;
/** Where a plant is preferably put: cells from the city it serves. */
const PLANT_DISTANCE = 110; // cells from its city on the reference map (grows with the city: see linearScale)
/** Chance of a plant on a map without a city; of a second plant on a map with two cities. */
const PLANT_NO_CITY = 0.5;
const PLANT_SECOND = 0.4;
/** Pylon span target (m), and how far (m) a pylon may slide along the line / sideways to find ground. */
const PYLON_SPAN = 70;
const PYLON_SLIDE = 30;
const PYLON_SIDE = 12;
/** Gap (m) between a site's fence and its end pylon. */
const TAP_GAP = 6;
/** Pylons keep off ground steeper than this. */
const PYLON_SLOPE = 0.3;
/** Import lines over a range accept steeper ground. */
const MOUNTAIN_PYLON_SLOPE = 0.65;
/** Utility poles: spacing, distance from the road edge, ends kept clear of junctions, other road clearance, bank limit (all m). */
const POLE_SPACING = 40;
const POLE_SETBACK = 2.9;
const POLE_END_MARGIN = 9;
const ROAD_CLEARANCE = 2.2;
const BUILDING_CLEARANCE = 1.8;
const MAX_BANK = 2.5;
/** Landmark feeds: how far (m) the nearest pole may be, and where the first pole stands from the structure's foot. */
const LANDMARK_REACH = 800;
const LANDMARK_GAP = 9;
/** How far (m) a site's feed may run to reach a road / the nearest pole. */
const FEED_REACH = 220;
/** Wires longer than this are not drawn (an underground gap). */
const MAX_LINK = 100;
/** Path length (m) up to which buildings / bases are fed from a substation. */
const SERVE_BUILDING = 900;
const SERVE_BASE = 1600;
/** A building within this distance (m) of a pole may get a pole transformer. */
const TRANSFORMER_REACH = 45;

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** Count of marked cells in a rectangle (inclusive corners) in O(1), from a summed-area table. */
function countTable(N: number, marked: (k: number) => boolean): (i0: number, j0: number, i1: number, j1: number) => number {
  const W = N + 1;
  const sat = new Int32Array(W * W);
  for (let j = 0; j < N; j++) {
    let row = 0;
    for (let i = 0; i < N; i++) {
      if (marked(j * N + i)) row++;
      sat[(j + 1) * W + i + 1] = sat[j * W + i + 1] + row;
    }
  }
  return (i0, j0, i1, j1) => sat[(j1 + 1) * W + i1 + 1] - sat[j0 * W + i1 + 1] - sat[(j1 + 1) * W + i0] + sat[j0 * W + i0];
}

/** Distance (cells, chamfer 3-4) from every cell to the nearest marked cell. */
function distanceField(mask: Uint8Array, N: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(N * N);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 0 : INF;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k - N] + 1);
        if (i > 0) v = Math.min(v, d[k - N - 1] + 1.4142);
        if (i < N - 1) v = Math.min(v, d[k - N + 1] + 1.4142);
      }
      d[k] = v;
    }
  for (let j = N - 1; j >= 0; j--)
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      let v = d[k];
      if (i < N - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < N - 1) {
        v = Math.min(v, d[k + N] + 1);
        if (i < N - 1) v = Math.min(v, d[k + N + 1] + 1.4142);
        if (i > 0) v = Math.min(v, d[k + N - 1] + 1.4142);
      }
      d[k] = v;
    }
  return d;
}

/** Spatial hash of points for "anything within r of here" queries. */
class PointHash<T extends { x: number; z: number }> {
  private cells = new Map<number, T[]>();
  private size: number;
  constructor(size: number) {
    this.size = size;
  }
  private key(cx: number, cz: number): number {
    return (cx + 2048) * 4096 + (cz + 2048);
  }
  add(p: T): void {
    const k = this.key(Math.floor(p.x / this.size), Math.floor(p.z / this.size));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(p);
  }
  /** Points in the 3x3 cells round (x, z). */
  around(x: number, z: number): T[] {
    const cx = Math.floor(x / this.size), cz = Math.floor(z / this.size);
    const out: T[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.push(...(this.cells.get(this.key(cx + dx, cz + dz)) ?? []));
    return out;
  }
}

/** Distance from a site's centre to its fence along the world direction (dx, dz) (unit). */
function siteExtent(site: PowerSite, dx: number, dz: number): number {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  const ux = Math.abs(dx * c - dz * s), uz = Math.abs(dx * s + dz * c);
  return Math.min(ux > 1e-6 ? site.width / 2 / ux : Infinity, uz > 1e-6 ? site.depth / 2 / uz : Infinity);
}

/** Nearest multiple of 90 degrees to the heading of (dx, dz), as a yaw (front = (sin yaw, cos yaw)). */
function quarterYaw(dx: number, dz: number): number {
  return Math.round(Math.atan2(dx, dz) / (Math.PI / 2)) * (Math.PI / 2);
}

interface Cell {
  i: number;
  j: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// The module

export function placePower(input: PowerInput, rng: Rng): PowerResult {
  const { N, cell, play, heights, mountain, riverMask, streamMask, clear, roads, cities, bases } = input;
  const half = ((N - 1) * cell) / 2;
  const clearing = new Uint8Array(N * N);
  const grid: PowerGrid = { sites: [], lines: [], poles: [], links: [] };

  const plantDistance = PLANT_DISTANCE * linearScale(play.i1 - play.i0 + 1);
  const wantPlants = cities.length ? 1 + (cities.length > 1 && rng() < PLANT_SECOND ? 1 : 0) : rng() < PLANT_NO_CITY ? 1 : 0;
  if (!wantPlants) {
    // No plant: the roads still carry poles, fed from outside the map (see planPoles).
    const ground = (x: number, z: number) => sampleGrid(heights, N, (x + half) / cell, (z + half) / cell);
    planPoles(input, grid, ground, half, (v) => (v + half) / cell, clearing);
    return { grid, clearing };
  }

  const slope = slopeField(heights, N, cell);
  const roadDist = distanceField(input.roadMask, N);
  const taken = Uint8Array.from(clear); // `clear` plus what this module adds as it goes
  const cellOf = (v: number) => (v + half) / cell;
  const worldOf = (c: number) => c * cell - half;
  /** Every 3rd point of the drivable roads (the substations face the nearest one). */
  const roadPoints = roads.edges.filter((e) => e.type !== 'rail').flatMap((e) => e.points.filter((_, n) => n % 3 === 0));
  // Nearest road point queries run per candidate cell: bucket the points (exact result, ties go to the earliest point as in a linear scan).
  const BUCKET = 64;
  const buckets = new Map<number, number[]>();
  const bucketKey = (bx: number, bz: number) => bx * 65536 + bz;
  roadPoints.forEach((p, n) => {
    const key = bucketKey(Math.floor(p.x / BUCKET), Math.floor(p.z / BUCKET));
    const list = buckets.get(key);
    if (list) list.push(n);
    else buckets.set(key, [n]);
  });
  const reachBuckets = Math.ceil(((N - 1) * cell) / BUCKET) + 2;
  const nearestRoadPoint = (wx: number, wz: number): { x: number; z: number } | null => {
    if (!roadPoints.length) return null;
    const bx = Math.floor(wx / BUCKET), bz = Math.floor(wz / BUCKET);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= reachBuckets; r++) {
      // Everything in ring r is at least (r - 1) * BUCKET away: stop once the best found is closer than that.
      if (best >= 0 && bestD < (r - 1) * BUCKET) break;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const list = buckets.get(bucketKey(bx + dx, bz + dz));
          if (!list) continue;
          for (const n of list) {
            const d = Math.hypot(roadPoints[n].x - wx, roadPoints[n].z - wz);
            if (d < bestD || (d === bestD && n < best)) {
              bestD = d;
              best = n;
            }
          }
        }
      }
    }
    return best >= 0 ? roadPoints[best] : null;
  };

  /** Pad rectangle in cells (half extents) of a site of this kind, scaled by `scale`, turned by `yaw`. */
  const footprint = (kind: PowerSiteKind, yaw: number, scale: number) => {
    const size = kind === 'plant' ? PLANT_SIZE : SUBSTATION_SIZE;
    const turned = Math.abs(Math.sin(yaw)) > 0.5;
    return {
      hx: Math.ceil(((turned ? size.depth : size.width) * scale) / 2 / cell),
      hz: Math.ceil(((turned ? size.width : size.depth) * scale) / 2 / cell),
    };
  };

  /**
   * Looks for a pad with the best `score`; its yaw (towards `facing(i, j)`) decides how the rectangle lies. Tries full size
   * first, then smaller pads (tight land: narrow beaches between sea and mountains), relaxing the slope limit at each size.
   */
  function findSite(
    kind: PowerSiteKind, facing: (i: number, j: number) => number, score: (i: number, j: number) => number,
  ): (Cell & { yaw: number; scale: number }) | null {
    for (const scale of SITE_SCALES) {
      for (const limit of SLOPE_TIERS) {
        const blocked = countTable(N, (k) => taken[k] > 0 || riverMask[k] > 0 || streamMask[k] > 0 || heights[k] < MIN_HEIGHT || mountain[k] > (limit > 0.3 ? 8 : 2.5) || slope[k] > limit);
        let best: (Cell & { yaw: number; scale: number }) | null = null, bestScore = -Infinity;
        // The yaw (a nearest-road search) is only worth computing where the smaller of the two pad orientations fits at all.
        const upright = footprint(kind, 0, scale), turned = footprint(kind, Math.PI / 2, scale);
        const minMx = Math.min(upright.hx, turned.hx) + SITE_MARGIN, minMz = Math.min(upright.hz, turned.hz) + SITE_MARGIN;
        for (let j = play.j0 + EDGE_INSET; j <= play.j1 - EDGE_INSET; j += 2) {
          for (let i = play.i0 + EDGE_INSET; i <= play.i1 - EDGE_INSET; i += 2) {
            if (i - minMx < play.i0 + 2 || j - minMz < play.j0 + 2 || i + minMx > play.i1 - 2 || j + minMz > play.j1 - 2) continue;
            if (blocked(i - minMx, j - minMz, i + minMx, j + minMz)) continue;
            const yaw = facing(i, j);
            const { hx, hz } = footprint(kind, yaw, scale);
            const mx = hx + SITE_MARGIN, mz = hz + SITE_MARGIN;
            if (i - mx < play.i0 + 2 || j - mz < play.j0 + 2 || i + mx > play.i1 - 2 || j + mz > play.j1 - 2) continue;
            if (blocked(i - mx, j - mz, i + mx, j + mz)) continue;
            const s = score(i, j);
            if (s > bestScore) {
              bestScore = s;
              best = { i, j, yaw, scale };
            }
          }
        }
        if (best) return best;
      }
    }
    return null;
  }

  /**
   * Levels the pad to its mean height, blending into the old ground over SITE_MARGIN cells (cells that are taken keep their
   * height); marks the pad taken / cleared. Returns the height.
   */
  function levelPad(ci: number, cj: number, hx: number, hz: number): number {
    let sum = 0, n = 0;
    for (let j = cj - hz; j <= cj + hz; j++) for (let i = ci - hx; i <= ci + hx; i++, n++) sum += heights[j * N + i];
    const target = sum / n;
    for (let j = cj - hz - SITE_MARGIN; j <= cj + hz + SITE_MARGIN; j++) {
      for (let i = ci - hx - SITE_MARGIN; i <= ci + hx + SITE_MARGIN; i++) {
        const d = Math.hypot(Math.max(Math.abs(i - ci) - hx, 0), Math.max(Math.abs(j - cj) - hz, 0));
        if (d >= SITE_MARGIN) continue;
        const k = j * N + i;
        if (d > 0 && taken[k]) continue;
        const t = 1 - d / SITE_MARGIN;
        heights[k] += (target - heights[k]) * (t * t * (3 - 2 * t));
        clearing[k] = 1;
      }
    }
    for (let j = cj - hz; j <= cj + hz; j++) for (let i = ci - hx; i <= ci + hx; i++) taken[j * N + i] = 1;
    return target;
  }

  function addSite(kind: PowerSiteKind, c: Cell & { yaw: number; scale: number }, city: number): PowerSite {
    const base = kind === 'plant' ? PLANT_SIZE : SUBSTATION_SIZE;
    const size = { width: base.width * c.scale, depth: base.depth * c.scale };
    const { hx, hz } = footprint(kind, c.yaw, c.scale);
    const y = levelPad(c.i, c.j, hx, hz);
    // The blend ring is not taken, but a following site keeps SITE_MARGIN off it: mark it so it is not built over.
    for (let j = c.j - hz - SITE_MARGIN; j <= c.j + hz + SITE_MARGIN; j++)
      for (let i = c.i - hx - SITE_MARGIN; i <= c.i + hx + SITE_MARGIN; i++) taken[j * N + i] = 1;
    const id = grid.sites.length;
    const seed = hash32(c.j * N + c.i, kind === 'plant' ? 0x9d1a : 0x5b57);
    const site: PowerSite = {
      id, kind, x: worldOf(c.i), y, z: worldOf(c.j), yaw: c.yaw, ...size, seed, city,
      stacks: kind === 'plant' ? 1 + (frac(seed, 1) < 0.5 ? 1 : 0) : 0,
      coolers: kind === 'plant' ? Math.floor(frac(seed, 2) * 3) : 0,
      feeder: -1,
    };
    grid.sites.push(site);
    return site;
  }

  // --- plants: one for the first city, maybe one for the second; else one near the middle of the map ---
  const targets: (City | null)[] = cities.length ? cities.slice(0, wantPlants) : [null];
  for (const city of targets) {
    const cx = city ? cellOf(city.x) : (play.i0 + play.i1) / 2, cz = city ? cellOf(city.z) : (play.j0 + play.j1) / 2;
    const score = (i: number, j: number) => {
      const d = Math.hypot(i - cx, j - cz);
      const toBase = bases.reduce((m, b) => Math.min(m, Math.hypot(i - cellOf(b.x), j - cellOf(b.z))), 1e9);
      const road = roadDist[j * N + i] < 40 ? 0.1 : 0; // a road not far off
      return (city ? -Math.abs(d - plantDistance) / plantDistance : -d / 200) + road + Math.min(toBase, 60) / 400 + rng() * 0.15;
    };
    const spot = findSite('plant', (i, j) => quarterYaw(cx - i, cz - j), score);
    if (spot) addSite('plant', spot, city ? city.id : -1);
  }
  if (cities.length && !grid.sites.length) return { grid, clearing };

  // --- substations: one per city, on its edge facing the nearest plant ---
  for (const city of cities) {
    const plant = grid.sites.filter((s) => s.kind === 'plant').sort((a, b) => Math.hypot(a.x - city.x, a.z - city.z) - Math.hypot(b.x - city.x, b.z - city.z))[0];
    if (!plant) break;
    const ccx = cellOf(city.x), ccz = cellOf(city.z);
    const reach = (city.radius * TOWN_REACH) / cell;
    const dx = plant.x - city.x, dz = plant.z - city.z, dl = Math.hypot(dx, dz) || 1;
    const tx = ccx + (dx / dl) * (reach + 12), tz = ccz + (dz / dl) * (reach + 12);
    const score = (i: number, j: number) => {
      const d = Math.hypot(i - ccx, j - ccz);
      if (d < reach + 6 || d > reach + 60) return -Infinity;
      return -Math.hypot(i - tx, j - tz) / 40 - roadDist[j * N + i] / 15 + rng() * 0.1;
    };
    // Faces the nearest road.
    const facing = (i: number, j: number) => {
      const wx = worldOf(i), wz = worldOf(j);
      const p = nearestRoadPoint(wx, wz);
      return p ? quarterYaw(p.x - wx, p.z - wz) : quarterYaw(ccx - i, ccz - j);
    };
    const spot = findSite('substation', facing, score);
    if (spot) addSite('substation', spot, city.id);
  }

  // --- high-voltage lines: minimum spanning tree over the sites, plant 0 first ---
  const { sites } = grid;
  const ground = (x: number, z: number) => sampleGrid(heights, N, cellOf(x), cellOf(z));
  const pylonOk = (x: number, z: number) => {
    const i = Math.round(cellOf(x)), j = Math.round(cellOf(z));
    if (i < 3 || j < 3 || i >= N - 3 || j >= N - 3) return false;
    const k = j * N + i;
    return heights[k] > WATER_LEVEL + 0.8 && !riverMask[k] && !streamMask[k] && !taken[k] && slope[k] <= PYLON_SLOPE;
  };
  const inTree = new Set<number>([0]);
  while (inTree.size < sites.length) {
    let best: [number, number] | null = null, bestLen = Infinity;
    for (const a of inTree)
      for (const b of sites.keys()) {
        if (inTree.has(b)) continue;
        const d = Math.hypot(sites[a].x - sites[b].x, sites[a].z - sites[b].z);
        if (d < bestLen) {
          bestLen = d;
          best = [a, b];
        }
      }
    if (!best) break;
    inTree.add(best[1]);
    const pylons = routePylons(sites[best[0]], sites[best[1]], pylonOk, ground, hash32(sites[best[0]].seed, sites[best[1]].seed));
    for (const p of pylons) markDisc(clearing, N, Math.round(cellOf(p.x)), Math.round(cellOf(p.z)), 3);
    grid.lines.push({ id: grid.lines.length, a: best[0], b: best[1], pylons });
  }

  // --- import lines: where a mountain range closes the map's edge, a line comes over it from the grid edge to the nearest plant ---
  const plants = sites.filter((s) => s.kind === 'plant');
  const mountainOk = (x: number, z: number) => {
    const i = Math.round(cellOf(x)), j = Math.round(cellOf(z));
    if (i < 3 || j < 3 || i >= N - 3 || j >= N - 3) return false;
    const k = j * N + i;
    return heights[k] > WATER_LEVEL + 0.8 && !riverMask[k] && !streamMask[k] && !taken[k] && slope[k] <= MOUNTAIN_PYLON_SLOPE;
  };
  const entries = plants.length
    ? input.mountainSides.map((side) => {
        // The edge point level with the nearest plant (kept off the corners), a few cells in from the grid border.
        const inset = 6 * cell, lo = worldOf(play.i0 + 20), hi = worldOf(play.i1 - 20);
        const clamp = (v: number) => Math.max(lo, Math.min(hi, v));
        const edge = half - inset;
        const best = plants.reduce((p, q) => {
          const along = side === 'north' || side === 'south' ? q.x : q.z;
          const d = Math.hypot(q.x - (side === 'east' ? edge : side === 'west' ? -edge : clamp(along)), q.z - (side === 'south' ? edge : side === 'north' ? -edge : clamp(along)));
          return d < p.d ? { q, d } : p;
        }, { q: plants[0], d: Infinity });
        const along = side === 'north' || side === 'south' ? best.q.x : best.q.z;
        const start = side === 'north' ? { x: clamp(along), z: -edge } : side === 'south' ? { x: clamp(along), z: edge } : side === 'west' ? { x: -edge, z: clamp(along) } : { x: edge, z: clamp(along) };
        return { start, plant: best.q, d: best.d };
      })
    : [];
  entries.sort((p, q) => p.d - q.d);
  for (const { start, plant } of entries.slice(0, 2)) {
    const pylons = routePylons(start, plant, mountainOk, ground, hash32(plant.seed, 0x1e7)) ;
    for (const p of pylons) markDisc(clearing, N, Math.round(cellOf(p.x)), Math.round(cellOf(p.z)), 3);
    if (pylons.length) grid.lines.push({ id: grid.lines.length, a: -1, b: plant.id, pylons });
  }

  // --- utility poles along the roads ---
  planPoles(input, grid, ground, half, cellOf, clearing);
  return { grid, clearing };
}

function markDisc(mask: Uint8Array, N: number, ci: number, cj: number, r: number): void {
  for (let j = cj - r; j <= cj + r; j++)
    for (let i = ci - r; i <= ci + r; i++) if (i >= 0 && j >= 0 && i < N && j < N && Math.hypot(i - ci, j - cj) <= r) mask[j * N + i] = 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// High-voltage lines

/** Pylons from site `a`'s gantry to site `b`'s, each slid along / beside the straight line to the nearest ground that fits. */
function routePylons(
  a: PowerSite | { x: number; z: number }, b: PowerSite, ok: (x: number, z: number) => boolean, ground: (x: number, z: number) => number, seed: number,
): Pylon[] {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  if (len < 1) return [];
  const ux = dx / len, uz = dz / len;
  // A plain point (the map edge) starts the line exactly there; a site starts it just outside its fence.
  const gapA = 'kind' in a ? siteExtent(a, ux, uz) + TAP_GAP : 0;
  const sx = a.x + ux * gapA, sz = a.z + uz * gapA;
  const ex = b.x - ux * (siteExtent(b, -ux, -uz) + TAP_GAP), ez = b.z - uz * (siteExtent(b, -ux, -uz) + TAP_GAP);
  const total = Math.hypot(ex - sx, ez - sz);
  if (total < 14) return [];
  const spans = Math.max(1, Math.round(total / PYLON_SPAN));
  const pts: [number, number][] = [[sx, sz]];
  for (let k = 1; k < spans; k++) {
    const t = k / spans;
    const bx = sx + (ex - sx) * t, bz = sz + (ez - sz) * t;
    let found: [number, number] | null = null;
    // Slide along the line first, then sideways, nearest tries first.
    outer: for (const side of [0, PYLON_SIDE / 2, -PYLON_SIDE / 2, PYLON_SIDE, -PYLON_SIDE]) {
      for (let along = 0; along <= PYLON_SLIDE; along += 4) {
        for (const sign of along ? [1, -1] : [1]) {
          const x = bx + ux * along * sign - uz * side, z = bz + uz * along * sign + ux * side;
          if (ok(x, z)) {
            found = [x, z];
            break outer;
          }
        }
      }
    }
    if (found) pts.push(found);
  }
  pts.push([ex, ez]);
  const height = 32 + frac(seed, 1) * 5;
  return pts.map(([x, z], n) => {
    const p = pts[Math.max(0, n - 1)], q = pts[Math.min(pts.length - 1, n + 1)];
    return { x, y: ground(x, z), z, yaw: Math.atan2(q[0] - p[0], q[1] - p[1]), height };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Utility poles

interface RoadPoint {
  x: number;
  z: number;
  edge: number;
  arc: number;
}

function planPoles(
  input: PowerInput, grid: PowerGrid, ground: (x: number, z: number) => number, half: number,
  cellOf: (v: number) => number, clearing: Uint8Array,
): void {
  const { N, riverMask, streamMask, roads, buildings, cities, bases } = input;
  const { nodes, edges } = roads;
  const sources = grid.sites.some((s) => s.kind === 'substation') ? grid.sites.filter((s) => s.kind === 'substation') : grid.sites.filter((s) => s.kind === 'plant');
  // Without any site the poles are fed from outside the map: through the road exits (else from the bases).
  const feedNodes = sources.length ? [] : nodes.filter((n) => n.kind === 'exit' && n.edges.some((id) => edges[id].type !== 'rail'));
  if (!feedNodes.length && !sources.length) feedNodes.push(...nodes.filter((n) => n.kind === 'base'));
  if (!sources.length && !feedNodes.length) return;

  // Arc lengths along every edge, and a hash of all non-rail road points.
  const arcs = edges.map((e) => {
    const a = [0];
    for (let i = 1; i < e.points.length; i++) a.push(a[i - 1] + Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z));
    return a;
  });
  const roadHash = new PointHash<RoadPoint>(16);
  edges.forEach((e, id) => e.points.forEach((p, i) => roadHash.add({ x: p.x, z: p.z, edge: id, arc: arcs[id][i] })));
  const onBridge = (e: RoadEdge, seg: number) => e.bridges.some((br) => seg >= br.start - 1 && seg <= br.end);
  const inTown = (x: number, z: number) => townAt(cities, x, z) >= 0;

  // --- which edges carry poles: Dijkstra over the road graph from the substations' nearest roads ---
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const via = new Int32Array(nodes.length).fill(-1); // edge that reached the node, -1 = a source
  const served = new Set<number>();
  for (const site of sources) {
    let id = -1, i = 0, bestD = FEED_REACH;
    for (const e of edges) {
      if (e.type === 'rail') continue;
      for (let n = 0; n < e.points.length; n++) {
        const p = e.points[n];
        const d = Math.hypot(p.x - site.x, p.z - site.z);
        if (d < bestD && !inTown(p.x, p.z) && !onBridge(e, n)) {
          bestD = d;
          id = e.id;
          i = n;
        }
      }
    }
    if (id < 0) continue;
    const e = edges[id], total = arcs[id][arcs[id].length - 1];
    served.add(id);
    dist[e.from] = Math.min(dist[e.from], arcs[id][i]);
    dist[e.to] = Math.min(dist[e.to], total - arcs[id][i]);
  }
  for (const n of feedNodes) dist[n.id] = 0;
  const done = new Uint8Array(nodes.length);
  for (;;) {
    let u = -1;
    for (let n = 0; n < nodes.length; n++) if (!done[n] && Number.isFinite(dist[n]) && (u < 0 || dist[n] < dist[u])) u = n;
    if (u < 0) break;
    done[u] = 1;
    for (const id of nodes[u].edges) {
      const e = edges[id];
      if (e.type === 'rail') continue;
      const v = e.from === u ? e.to : e.from;
      if (dist[u] + e.length < dist[v]) {
        dist[v] = dist[u] + e.length;
        via[v] = id;
      }
    }
  }
  /** Marks the edges of the shortest path back from a node. */
  const serveBack = (node: number) => {
    for (let n = node; via[n] >= 0; ) {
      served.add(via[n]);
      const e = edges[via[n]];
      n = e.from === n ? e.to : e.from;
    }
  };
  // Demand: rural buildings that are lived in (or being built), and the bases.
  const demand: { building: Building; edge: number }[] = [];
  for (const b of buildings) {
    if (b.city >= 0 || b.condition === 'abandoned') continue;
    let best: RoadPoint | null = null, bestD = 50;
    for (const p of roadHash.around(b.x, b.z)) {
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) continue;
    const e = edges[best.edge];
    const total = arcs[best.edge][arcs[best.edge].length - 1];
    const viaFrom = dist[e.from] + best.arc, viaTo = dist[e.to] + total - best.arc;
    if (Math.min(viaFrom, viaTo) > SERVE_BUILDING) continue;
    served.add(best.edge);
    serveBack(viaFrom <= viaTo ? e.from : e.to);
    demand.push({ building: b, edge: best.edge });
  }
  for (const nd of nodes) if (nd.kind === 'base' && dist[nd.id] <= SERVE_BASE) serveBack(nd.id);

  // --- poles along the served edges ---
  const baseAt = (x: number, z: number) => {
    const i = cellOf(x), j = cellOf(z);
    return bases.some((b) => i >= b.i0 - 1 && i <= b.i1 + 1 && j >= b.j0 - 1 && j <= b.j1 + 1);
  };
  const nearBuilding = (x: number, z: number) =>
    buildings.some((b) => {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > 40 || Math.abs(dz) > 40) return false;
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      return Math.abs(dx * c - dz * s) < b.width / 2 + BUILDING_CLEARANCE && Math.abs(dx * s + dz * c) < b.depth / 2 + BUILDING_CLEARANCE;
    });
  const freeSpot = (x: number, z: number) => {
    if (Math.abs(x) > half - 4 || Math.abs(z) > half - 4) return false;
    const k = Math.round(cellOf(z)) * N + Math.round(cellOf(x));
    return ground(x, z) > WATER_LEVEL + 0.4 && !riverMask[k] && !streamMask[k] && !baseAt(x, z) && !nearBuilding(x, z);
  };

  const { poles, links } = grid;
  const kept = new Map<number, number[]>(); // edge -> pole indices in order
  const addPole = (x: number, z: number, yaw: number, edge: number): number => {
    const seed = hash32(Math.round(x * 4), Math.round(z * 4));
    poles.push({ x, y: ground(x, z), z, yaw, height: 9 + frac(seed, 1) * 2.2, edge, transformer: false, seed });
    markDisc(clearing, N, Math.round(cellOf(x)), Math.round(cellOf(z)), 1);
    return poles.length - 1;
  };
  for (const id of [...served].sort((a, b) => a - b)) {
    const e = edges[id], pts = e.points, arc = arcs[id], total = arc[arc.length - 1];
    const list: number[] = [];
    const count = total <= 2 * POLE_END_MARGIN ? 1 : Math.ceil((total - 2 * POLE_END_MARGIN) / POLE_SPACING) + 1;
    let seg = 0;
    for (let n = 0; n < count; n++) {
      const d = count === 1 ? total / 2 : POLE_END_MARGIN + ((total - 2 * POLE_END_MARGIN) * n) / (count - 1);
      while (seg < pts.length - 2 && arc[seg + 1] < d) seg++;
      const f = (d - arc[seg]) / Math.max(1e-6, arc[seg + 1] - arc[seg]);
      const a = pts[seg], b = pts[seg + 1];
      const px = a.x + (b.x - a.x) * f, py = a.y + (b.y - a.y) * f, pz = a.z + (b.z - a.z) * f;
      if (inTown(px, pz) || onBridge(e, seg)) continue;
      const p0 = pts[Math.max(0, seg - 1)], p1 = pts[Math.min(pts.length - 1, seg + 2)];
      const tl = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
      const tx = (p1.x - p0.x) / tl, tz = (p1.z - p0.z) / tl;
      const offset = e.width / 2 + POLE_SETBACK;
      const preferred = id % 2 ? 1 : -1;
      for (const side of [preferred, -preferred]) {
        const x = px - tz * side * offset, z = pz + tx * side * offset;
        if (inTown(x, z) || !freeSpot(x, z) || Math.abs(ground(x, z) - py) > MAX_BANK) continue;
        const clashes = roadHash.around(x, z).some((s) => !(s.edge === id && Math.abs(s.arc - d) < 25) && Math.hypot(s.x - x, s.z - z) < edges[s.edge].width / 2 + ROAD_CLEARANCE);
        if (clashes) continue;
        list.push(addPole(x, z, Math.atan2(tx, tz), id));
        break;
      }
    }
    kept.set(id, list);
    for (let n = 1; n < list.length; n++) tryLink(list[n - 1], list[n]);
  }
  function tryLink(a: number, b: number): void {
    if (a !== b && Math.hypot(poles[a].x - poles[b].x, poles[a].z - poles[b].z) <= MAX_LINK) links.push([a, b]);
  }

  // Junctions: the poles of the served edges nearest each node are wired together (the first one is the hub).
  for (const nd of nodes) {
    const ends: number[] = [];
    for (const id of nd.edges) {
      const list = kept.get(id);
      if (!list?.length) continue;
      const pole = poles[nd.id === edges[id].from ? list[0] : list[list.length - 1]];
      if (Math.hypot(pole.x - nd.x, pole.z - nd.z) <= 30) ends.push(nd.id === edges[id].from ? list[0] : list[list.length - 1]);
    }
    for (let n = 1; n < ends.length; n++) tryLink(ends[0], ends[n]);
  }

  // Feeders: from each source site's fence to the nearest pole, a straight run of poles.
  const edgePoles = poles.length;
  for (const site of sources) {
    let target = -1, targetD = FEED_REACH;
    for (let n = 0; n < edgePoles; n++) {
      const d = Math.hypot(poles[n].x - site.x, poles[n].z - site.z);
      if (d < targetD) {
        targetD = d;
        target = n;
      }
    }
    if (target < 0) continue;
    const tp = poles[target];
    const dx = tp.x - site.x, dz = tp.z - site.z, dl = Math.hypot(dx, dz) || 1;
    const ux = dx / dl, uz = dz / dl;
    const start = siteExtent(site, ux, uz) + 3.5;
    const steps = Math.max(1, Math.ceil((dl - start) / 35));
    let prev = -1;
    for (let n = 0; n < steps; n++) {
      const d = start + ((dl - start) * n) / steps;
      const x = site.x + ux * d, z = site.z + uz * d;
      if (!freeSpot(x, z)) continue;
      const pole = addPole(x, z, Math.atan2(ux, uz), -1);
      if (prev < 0) site.feeder = pole;
      else tryLink(prev, pole);
      prev = pole;
    }
    if (prev >= 0) tryLink(prev, target);
  }

  // Landmarks (lighthouses on the beaches, radar / telecom towers on the mountains): a run of poles from the structure to the
  // nearest pole of the network (nothing is drawn when no pole is within LANDMARK_REACH).
  const network = poles.length;
  for (const lm of input.landmarks) {
    let target = -1, targetD = LANDMARK_REACH;
    for (let n = 0; n < network; n++) {
      const d = Math.hypot(poles[n].x - lm.x, poles[n].z - lm.z);
      if (d < targetD) {
        targetD = d;
        target = n;
      }
    }
    if (target < 0) continue;
    const tp = poles[target];
    const dx = tp.x - lm.x, dz = tp.z - lm.z, dl = Math.hypot(dx, dz) || 1;
    const ux = dx / dl, uz = dz / dl;
    // First pole: the nearest free spot round the foot (beaches drop into the sea, towers sit on slopes), preferring the way to the target.
    let first: [number, number] | null = null;
    search: for (const r of [LANDMARK_GAP, LANDMARK_GAP * 1.6, LANDMARK_GAP * 2.5]) {
      for (const turn of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2, -2, Math.PI]) {
        const a = Math.atan2(ux, uz) + turn;
        const x = lm.x + Math.sin(a) * r, z = lm.z + Math.cos(a) * r;
        if (freeSpot(x, z)) {
          first = [x, z];
          break search;
        }
      }
    }
    if (!first) continue;
    let prev = addPole(first[0], first[1], Math.atan2(tp.x - first[0], tp.z - first[1]), -1);
    const fx = tp.x - first[0], fz = tp.z - first[1], fl = Math.hypot(fx, fz) || 1;
    const steps = Math.max(1, Math.ceil(fl / 35));
    for (let n = 1; n < steps; n++) {
      const x = first[0] + (fx * n) / steps, z = first[1] + (fz * n) / steps;
      // Slide sideways when the spot is taken.
      const spot = [0, 4, -4, 8, -8].map((s) => [x - (fz / fl) * s, z + (fx / fl) * s] as const).find(([sx, sz]) => freeSpot(sx, sz));
      if (!spot) continue;
      const pole = addPole(spot[0], spot[1], Math.atan2(fx, fz), -1);
      tryLink(prev, pole);
      prev = pole;
    }
    tryLink(prev, target);
  }

  // Pole transformers where a served building stands close to a pole of its road.
  for (const { building, edge } of demand) {
    let best = -1, bestD = TRANSFORMER_REACH;
    for (const n of kept.get(edge) ?? []) {
      const d = Math.hypot(poles[n].x - building.x, poles[n].z - building.z);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best >= 0) poles[best].transformer = true;
  }
}
