// Street light placement along the road network. Pure data (no Three.js): deterministic from the
// roads alone, so it needs no random stream. Asphalt roads get tall, closely spaced lamps on
// alternating sides; dirt roads get sparse wooden poles with a hanging lantern.

import { sampleGrid } from './grid.ts';
import type { RoadEdge, RoadNetwork, RoadType } from './modules/roads/types.ts';
import type { Terrain } from './generate.ts';
import { CURB_GAP, townAt } from './urban.ts';

/** Road types that get street lights (not the railway). */
export type LitRoadType = Exclude<RoadType, 'rail'>;
/** Lamp kinds: along a road of that type, or in a car park. */
export type LampKind = LitRoadType | 'parking';

export interface StreetLight {
  /** Foot of the pole; y is the ground height there. */
  x: number;
  y: number;
  z: number;
  /** Unit horizontal direction from the pole towards the road / into the car park (the lamp arm points this way). */
  dx: number;
  dz: number;
  kind: LampKind;
  /** Road edge the lamp stands along; -1 in a car park. */
  edge: number;
  /** Car park (ParkingLot id) the lamp lights; -1 along a road. */
  lot: number;
}

/** Car park lamps: about one per this many metres of the lot's width, along its back edge. */
const PARKING_LAMP_SPACING = 14;
/** Pole distance inside the car park's back edge (the back row's cars start ~1 m in). */
const PARKING_LAMP_INSET = 0.3;

/**
 * Lamps of the town car parks: poles along the back edge (away from the street, clear of the bays' cars), arms
 * reaching over the lot. Pure, no rng.
 */
export function planParkingLights(t: Pick<Terrain, 'parking'>): StreetLight[] {
  const out: StreetLight[] = [];
  for (const lot of t.parking) {
    const c = Math.cos(lot.yaw), s = Math.sin(lot.yaw);
    const count = Math.max(1, Math.round(lot.width / PARKING_LAMP_SPACING));
    const v = -lot.depth / 2 + PARKING_LAMP_INSET;
    for (let k = 0; k < count; k++) {
      const u = -lot.width / 2 + (lot.width * (k + 0.5)) / count;
      out.push({ x: lot.x + u * c + v * s, y: lot.y, z: lot.z - u * s + v * c, dx: s, dz: c, kind: 'parking', edge: -1, lot: lot.id });
    }
  }
  return out;
}

interface Style {
  /** Distance along the road between lamps. */
  spacing: number;
  /** Pole distance from the road edge. */
  setback: number;
  /** No lamps this close to a road node (junctions, bases, exits). */
  nodeClearance: number;
}

const STYLE: Record<LitRoadType, Style> = {
  asphalt: { spacing: 18, setback: 1.3, nodeClearance: 9 },
  dirt: { spacing: 30, setback: 1.1, nodeClearance: 7 },
};
/** Town streets (asphalt in a town): close-set lamps on the sidewalk by the curb, clear of crosswalks / traffic lights. */
const TOWN: Style = { spacing: 9, setback: CURB_GAP + 0.55, nodeClearance: 13 };
/** Pole clearance (m) from the edge of any other road, a rock's radius or a tree trunk. */
const ROAD_CLEARANCE = 1.8;
const TREE_CLEARANCE = 1.6;
/** Pole clearance (m) from a building's walls (awnings, canopies and porches reach out over the yard). */
const BUILDING_CLEARANCE = 1.2;
/** Poles don't stand on slopes steeper than this height gap to the road surface. */
const MAX_BANK = 1.6;
/** Points of the same edge closer than this along the road are the lamp's own road, not an obstacle. */
const OWN_ROAD_ARC = 25;
const HASH_CELL = 8;

interface Spot {
  x: number;
  z: number;
  /** Radius around it that is taken (road half width, rock size, tree trunk). */
  r: number;
  edge: number;
  arc: number;
}

/** Coarse spatial hash for "anything within r of here" queries. */
class SpotHash {
  private cells = new Map<number, Spot[]>();
  private key(cx: number, cz: number): number {
    return (cx + 512) * 1024 + (cz + 512);
  }
  add(s: Spot): void {
    const k = this.key(Math.floor(s.x / HASH_CELL), Math.floor(s.z / HASH_CELL));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(s);
  }
  near(x: number, z: number, fn: (s: Spot) => boolean): boolean {
    const cx = Math.floor(x / HASH_CELL), cz = Math.floor(z / HASH_CELL);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const s of this.cells.get(this.key(cx + dx, cz + dz)) ?? []) if (fn(s)) return true;
    return false;
  }
}

export function planStreetLights(t: Terrain): StreetLight[] {
  const { nodes, edges } = t.roads;
  const half = t.worldSize / 2;
  const ground = (x: number, z: number) => sampleGrid(t.heights, t.size, (x + half) / t.cell, (z + half) / t.cell);

  const hash = new SpotHash();
  for (const e of edges) {
    let arc = 0;
    e.points.forEach((p, i) => {
      if (i) arc += Math.hypot(p.x - e.points[i - 1].x, p.z - e.points[i - 1].z);
      hash.add({ x: p.x, z: p.z, r: e.width / 2, edge: e.id, arc });
    });
  }
  const props = new SpotHash();
  for (const r of t.rocks) props.add({ x: r.x, z: r.z, r: r.size, edge: -1, arc: 0 });
  for (const tree of t.trees.trees) props.add({ x: tree.x, z: tree.z, r: 0.4 * tree.scale, edge: -1, arc: 0 });
  /** Pole within BUILDING_CLEARANCE of a building's footprint. */
  const nearBuilding = (x: number, z: number) =>
    t.buildings.some((b) => {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > 40 || Math.abs(dz) > 40) return false;
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      return Math.abs(dx * c - dz * s) < b.width / 2 + BUILDING_CLEARANCE && Math.abs(dx * s + dz * c) < b.depth / 2 + BUILDING_CLEARANCE;
    });

  const out: StreetLight[] = [];
  for (const e of edges) {
    if (e.type === 'rail') continue; // unlit, but kept in `hash`: poles stand clear of the track
    const pts = e.points;
    // Arc length at every point.
    const arcs = [0];
    for (let i = 1; i < pts.length; i++) arcs.push(arcs[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const total = arcs[arcs.length - 1];

    let seg = 0;
    let n = 0;
    let style = STYLE[e.type];
    for (let d = style.spacing * 0.5; d < total; d += style.spacing, n++) {
      while (seg < pts.length - 2 && arcs[seg + 1] < d) seg++;
      const f = (d - arcs[seg]) / Math.max(1e-6, arcs[seg + 1] - arcs[seg]);
      const a = pts[seg], b = pts[seg + 1];
      const px = a.x + (b.x - a.x) * f, py = a.y + (b.y - a.y) * f, pz = a.z + (b.z - a.z) * f;
      const town = e.type === 'asphalt' && townAt(t.cities, px, pz) >= 0;
      style = town ? TOWN : STYLE[e.type];
      const offset = e.width / 2 + style.setback;
      if (onBridge(e, seg)) continue;
      if (nodes.some((nd) => Math.hypot(nd.x - px, nd.z - pz) < style.nodeClearance)) continue;

      // Tangent over a short window (smooth on curves), then the side the pole stands on.
      const p0 = pts[Math.max(0, seg - 1)], p1 = pts[Math.min(pts.length - 1, seg + 2)];
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
      const tx = (p1.x - p0.x) / len, tz = (p1.z - p0.z) / len;
      const side = (n + e.id) % 2 ? 1 : -1;
      const nx = -tz * side, nz = tx * side; // from the road towards the pole
      const x = px + nx * offset, z = pz + nz * offset;
      if (Math.abs(x) > half - 3 || Math.abs(z) > half - 3) continue;

      // In town the pole stands on the sidewalk, which is level with the road.
      const y = town ? py : ground(x, z);
      if (ground(x, z) <= t.waterLevel + 0.2 || (!town && Math.abs(y - py) > MAX_BANK)) continue;
      const blockedByRoad = hash.near(x, z, (s) => {
        if (s.edge === e.id && Math.abs(s.arc - d) < OWN_ROAD_ARC) return false;
        return Math.hypot(s.x - x, s.z - z) < s.r + ROAD_CLEARANCE;
      });
      if (blockedByRoad) continue;
      if (props.near(x, z, (s) => Math.hypot(s.x - x, s.z - z) < s.r + TREE_CLEARANCE)) continue;
      if (nearBuilding(x, z)) continue;

      out.push({ x, y, z, dx: -nx, dz: -nz, kind: e.type, edge: e.id, lot: -1 });
    }
  }
  return out;
}

function onBridge(e: RoadEdge, seg: number): boolean {
  return e.bridges.some((br) => seg >= br.start - 1 && seg <= br.end);
}

/**
 * Street id per road edge: a road passing straight through a junction or level crossing is one street, even though
 * the node splits it into edges. At each node, same-type edges leaving in near-opposite directions are paired up
 * (straightest pair first). The id is the smallest edge id of the street.
 */
export function streetIds({ nodes, edges }: RoadNetwork): number[] {
  const parent = edges.map((e) => e.id);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const leaving = (e: RoadEdge, node: number): [number, number] => {
    const pts = e.from === node ? e.points : [...e.points].reverse();
    const a = pts[0], b = pts[Math.min(3, pts.length - 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return [(b.x - a.x) / len, (b.z - a.z) / len];
  };
  for (const node of nodes) {
    const here = node.edges.map((id) => edges[id]).filter((e) => e.type !== 'rail');
    const pairs: [number, RoadEdge, RoadEdge][] = [];
    for (let a = 0; a < here.length; a++)
      for (let b = a + 1; b < here.length; b++) {
        if (here[a].type !== here[b].type) continue;
        const [ax, az] = leaving(here[a], node.id), [bx, bz] = leaving(here[b], node.id);
        const dot = ax * bx + az * bz;
        if (dot < -STREET_STRAIGHT) pairs.push([dot, here[a], here[b]]);
      }
    pairs.sort((p, q) => p[0] - q[0]);
    const used = new Set<number>();
    for (const [, a, b] of pairs) {
      if (used.has(a.id) || used.has(b.id)) continue;
      used.add(a.id).add(b.id);
      const ra = find(a.id), rb = find(b.id);
      parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }
  return edges.map((e) => find(e.id));
}

/** Edges meeting at a node continue one street when they leave it at least this opposite (cosine; ~135 degrees apart). */
const STREET_STRAIGHT = 0.7;
