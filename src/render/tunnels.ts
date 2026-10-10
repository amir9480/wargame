// Tunnel portals where a road or railway leaves the map into a mountain range (RoadNode.tunnel): a concrete headwall
// with a black opening and wing walls along the approach. The road carving raises an earth mound over the barrel
// behind it (roads/carve.ts, sizes from roads/sites.ts), so the headwall sits against the slope. A handful of boxes
// per portal, so it is the same mesh near and far.

import type { Terrain } from '../terrain/generate.ts';
import { TUNNEL_COVER, TUNNEL_SPAN_EXTRA } from '../terrain/modules/roads/sites.ts';
import { MeshData } from './buildings/geometry.ts';

const CONCRETE = 0x9b978d;
const OPENING = 0x040404;
/** Clear height of the opening; the headwall stands a little above the mound behind it (m). */
const CLEAR = 5.4;
const WALL = TUNNEL_COVER + 0.6;
/** Opening width beyond the road, and the pillars beside it filling the rest of the headwall (m). */
const OPEN_EXTRA = 0.8;
const PILLAR = (TUNNEL_SPAN_EXTRA - OPEN_EXTRA) / 2;
/** Headwall depth, a short barrel stub behind it (inside the mound) and how far it all reaches below the road (m). */
const DEPTH = 1.2;
const BARREL = 4;
const FOOTING = 3;

/** Portal geometry for every tunnel exit (vertex layout of the building shader: aWin = 0). */
export function tunnelPortals(t: Terrain): MeshData {
  const m = new MeshData({ aWin: 2 });
  m.cur.aWin = [0, 0];
  for (const node of t.roads.nodes) {
    if (!node.tunnel) continue;
    const edge = t.roads.edges[node.edges[0]];
    if (!edge) continue;
    // Heading into the mountain: along the edge's last few metres towards this node (a straight approach).
    const pts = edge.to === node.id ? edge.points : [...edge.points].reverse();
    const end = pts[pts.length - 1], back = pts[Math.max(0, pts.length - 4)];
    const yaw = Math.atan2(end.x - back.x, end.z - back.z);
    const open = edge.width + OPEN_EXTRA;
    const span = open + 2 * PILLAR;
    m.frame(node.x, node.y, node.z, yaw);
    // Opening first (just in front of the headwall face), then the concrete around it.
    m.setColor(OPENING);
    m.box(0, -0.2, 0.05 + (DEPTH + BARREL) / 2, open, CLEAR + 0.2, DEPTH + BARREL);
    m.setColor(CONCRETE);
    for (const side of [-1, 1]) m.box(side * (open + PILLAR) / 2, -FOOTING, DEPTH / 2, PILLAR, WALL + FOOTING, DEPTH);
    m.box(0, CLEAR, DEPTH / 2, span, WALL - CLEAR, DEPTH);
    m.setColor(CONCRETE, 0.92);
    m.box(0, WALL - 0.1, DEPTH / 2, span + 0.4, 0.5, DEPTH + 0.4); // coping
    m.setColor(CONCRETE, 0.8);
    m.box(0, -FOOTING, DEPTH + BARREL / 2, span, TUNNEL_COVER - 0.5 + FOOTING, BARREL);
    // Wing walls retaining the cut slopes on both sides of the approach, splayed outward.
    m.setColor(CONCRETE, 0.95);
    const len = 7, splay = 0.3;
    for (const side of [-1, 1]) {
      m.box(side * (span / 2 - 0.4 + (Math.sin(splay) * len) / 2), -FOOTING, -len / 2 + 0.2, 0.8, WALL * 0.7 + FOOTING, len, side * splay);
    }
  }
  return m;
}
