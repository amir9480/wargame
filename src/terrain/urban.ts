// Town street furniture, planned from the finished map: which road stretches have sidewalks, where crosswalks and
// stop lines are painted at intersections, and the traffic lights there with their timing. Pure data and no random
// stream (hashes of the seed and node ids), so every client gets the same signals in the same phase; gameplay / AI
// can ask `signalAt` what a light shows at a given time.

import { hash32 } from '../core/rng.ts';
import type { City } from './buildings/types.ts';
import type { RoadEdge, RoadPoint } from './modules/roads/types.ts';
import type { Terrain } from './pipeline/types.ts';

/** Sidewalk width beyond the curb and curb width at the road edge (m). Both are painted flat on the road ribbon. */
export const SIDEWALK_WIDTH = 3;
export const CURB_GAP = 0.2;
/** Crosswalk depth (along the road) and the gap from it to the stop line (m). */
export const CROSSWALK = 3;
export const STOP_LINE_GAP = 0.6;
export const STOP_LINE = 0.45;
/** Signal cycle (s): each group of approaches gets green, then yellow, then red while the other group goes. */
export const SIGNAL_GREEN = 9;
export const SIGNAL_YELLOW = 2.5;
export const SIGNAL_CYCLE = 2 * (SIGNAL_GREEN + SIGNAL_YELLOW);
/** Share of three-way town junctions with traffic lights (four-way ones always have them). */
const T_SIGNAL_SHARE = 0.5;
/** Town extent for street furniture, as a factor on City.radius (streets reach the ragged edge). */
export const TOWN_REACH = 1.25;

export type SignalColor = 'green' | 'yellow' | 'red';

/** One road arriving at a town intersection. */
export interface Approach {
  edge: number;
  /** Which end of the edge is at the intersection (0 = points[0]). */
  end: 0 | 1;
  /** Distance (m, along the edge from the node) where the crosswalk starts; the stop line follows after it. */
  crosswalk: number;
  /** Signal group (0 / 1): approaches of a group share their lights. */
  group: 0 | 1;
  /** Traffic light pole (null without signals): foot position on the sidewalk, right of the arriving traffic, and the
   * yaw that turns the model's +Z (the signal faces) towards that traffic. */
  pole: { x: number; y: number; z: number; yaw: number } | null;
}

export interface Intersection {
  node: number;
  x: number;
  y: number;
  z: number;
  signals: boolean;
  /** Seconds added to the clock for this intersection's cycle (they don't all switch together). */
  offset: number;
  approaches: Approach[];
}

/** Town (index into cities) whose area contains world (x, z), else -1. */
export function townAt(cities: City[], x: number, z: number): number {
  for (const c of cities) if (Math.hypot(x - c.x, z - c.z) < c.radius * TOWN_REACH) return c.id;
  return -1;
}

/** Unit horizontal direction of edge `e` leaving node `nodeId`. */
export function leavingDir(e: RoadEdge, nodeId: number): [number, number] {
  const pts = e.from === nodeId ? e.points : [...e.points].reverse();
  const a = pts[0], b = pts[Math.min(2, pts.length - 1)];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return [(b.x - a.x) / len, (b.z - a.z) / len];
}

/** Road surface point `dist` metres along edge `e` from its end `end`. */
export function pointAlong(e: RoadEdge, end: 0 | 1, dist: number): RoadPoint {
  const pts = end === 0 ? e.points : [...e.points].reverse();
  let left = dist;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    if (step >= left) {
      const f = step ? left / step : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
    left -= step;
  }
  return pts[pts.length - 1];
}

/** Town intersections: nodes inside a town where three or more roads (not rail) meet. */
export function planIntersections(t: Pick<Terrain, 'seed' | 'roads' | 'cities'>): Intersection[] {
  const { nodes, edges } = t.roads;
  const out: Intersection[] = [];
  for (const node of nodes) {
    const here = node.edges.map((id) => edges[id]).filter((e) => e.type !== 'rail');
    if (here.length < 3 || node.edges.length !== here.length || townAt(t.cities, node.x, node.z) < 0) continue;
    const h = hash32(t.seed, node.id + 0x7a11);
    const signals = here.length >= 4 || (h % 1000) / 1000 < T_SIGNAL_SHARE;
    const dirs = here.map((e) => leavingDir(e, node.id));
    const approaches = here.map((e, i): Approach => {
      const [dx, dz] = dirs[i];
      // Clear of every other road's carriageway (wider where they meet at a slant).
      let crosswalk = 0;
      dirs.forEach(([ox, oz], j) => {
        if (j === i) return;
        const sin = Math.max(0.5, Math.abs(dx * oz - dz * ox));
        crosswalk = Math.max(crosswalk, (here[j].width / 2 + CURB_GAP) / sin + 1);
      });
      const group: 0 | 1 = Math.abs(dx * dirs[0][0] + dz * dirs[0][1]) > 0.7 ? 0 : 1;
      let pole: Approach['pole'] = null;
      if (signals) {
        // Right of the traffic arriving along -dir: (dz, -dx). Just behind the stop line, on the sidewalk.
        const along = crosswalk + CROSSWALK + STOP_LINE_GAP + STOP_LINE + 0.6;
        const side = e.width / 2 + CURB_GAP + 0.7;
        pole = {
          x: node.x + dx * along + dz * side,
          y: pointAlong(e, e.from === node.id ? 0 : 1, along).y,
          z: node.z + dz * along - dx * side,
          yaw: Math.atan2(dx, dz),
        };
      }
      return { edge: e.id, end: e.from === node.id ? 0 : 1, crosswalk, group, pole };
    });
    out.push({ node: node.id, x: node.x, y: node.y, z: node.z, signals, offset: ((h >>> 10) % 1000) / 1000 * SIGNAL_CYCLE, approaches });
  }
  return out;
}

/** What the lights of `group` at an intersection show at `time` seconds (any shared clock). */
export function signalAt(time: number, group: 0 | 1, offset: number): SignalColor {
  const t = (((time + offset - group * (SIGNAL_GREEN + SIGNAL_YELLOW)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return t < SIGNAL_GREEN ? 'green' : t < SIGNAL_GREEN + SIGNAL_YELLOW ? 'yellow' : 'red';
}

/** Crosswalk start distance at each end of every edge that has one (0 = none), from the intersection plan. */
export function crosswalkEnds(plan: Intersection[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  for (const x of plan)
    for (const a of x.approaches) {
      const v = out.get(a.edge) ?? [0, 0];
      v[a.end] = a.crosswalk;
      out.set(a.edge, v);
    }
  return out;
}
