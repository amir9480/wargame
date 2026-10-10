// Flattens the terrain under roads (cut and fill) and marks the cells they occupy.

import { lerp, smoothstep } from '../../../core/noise.ts';
import { WATER_LEVEL } from '../../types.ts';
import { sampleGrid } from '../../grid.ts';
import { CURB_GAP, SIDEWALK_WIDTH } from '../../urban.ts';
import { ROAD_WIDTH } from './types.ts';
import type { RoadContext } from './context.ts';
import type { ShapedEdge } from './shape.ts';
import { TUNNEL_BARREL, TUNNEL_COVER, TUNNEL_SPAN_EXTRA } from './sites.ts';

/** Width of the graded shoulder beyond the road edge, in grid cells. */
const SHOULDER = 2.5;
/**
 * Ground this far (cells) beyond a road's edge is levelled to the road surface: the ribbon (incl. its ragged
 * margin) never lies over a terrain triangle that rises above it, and other roads' shoulders can't lift it.
 */
const CORE = 1;
/** Town asphalt draws curb + sidewalk on its ribbon beyond the carriageway (urban.ts): that much more is levelled (m). */
const TOWN_WALK = CURB_GAP + SIDEWALK_WIDTH;
/** Railway cuttings and embankments: extra shoulder per metre of cut / fill (cells), up to RAIL_SLOPE_MAX. */
const RAIL_SLOPE = 1.2;
const RAIL_SLOPE_MAX = 14;

/** Intersection pads: flat ground this far (cells) beyond the widest road's edge, then blended into the land over PAD_BLEND. */
export const PAD_MARGIN = 2;
const PAD_BLEND = 4;

/** Flat area around an intersection (junction / level crossing), like a small levelled base: centre and radius in cells, height in m. */
export interface RoadPad {
  x: number;
  y: number;
  height: number;
  radius: number;
}

/**
 * Returns a mask of cells covered by roads (incl. bridges).
 * Cells under a road surface take the height of the nearest surface point. Shoulder cells take the strongest
 * cut / fill of every shoulder reaching them (not just the nearest road's): where a narrow road shoulder meets a
 * railway's wide embankment, the ground between them is filled instead of left as a pit.
 * `pads` level the ground around intersections to the node height, so every road arrives on flat ground.
 * Player base build areas (`keep`) are never regraded. `inTown(x, y)` (grid cells) = asphalt there has sidewalks,
 * whose full width is levelled too, so slopes beside a town street don't bury them.
 * `level` marks the cells set to a road surface or pad height (later ground edits, e.g. building pads, keep off them).
 * `tunnels` = node ids of tunnel portals: nothing beyond the portal plane of an edge ending there is regraded.
 */
export function carveRoads(
  { N, cell, heights, keep }: RoadContext, shaped: ShapedEdge[], pads: RoadPad[] = [], inTown: (x: number, y: number) => boolean = () => false,
  tunnels: ReadonlySet<number> = new Set(),
): { covered: Uint8Array; level: Uint8Array } {
  const ground = heights.slice();
  const dist = new Float32Array(N * N).fill(Infinity);
  /** The nearest road point is on a bridge span: the ground under the deck is left alone. */
  const underBridge = new Uint8Array(N * N);
  const coreDist = new Float32Array(N * N).fill(Infinity);
  const coreY = new Float32Array(N * N);
  /** Graded height from the strongest shoulder (NaN = none). */
  const graded = new Float32Array(N * N).fill(NaN);
  const covered = new Uint8Array(N * N);
  const level = new Uint8Array(N * N);

  // Per edge: the nearest point of that edge for every cell it reaches (one smooth falloff per road; taking
  // points farther along a sloped road would scallop the shoulder).
  const edgeDist = new Float32Array(N * N).fill(Infinity);
  const edgeY = new Float32Array(N * N);
  const edgeR = new Float32Array(N * N);
  /** Levelled half width (cells) of the nearest point: road + CORE, plus the sidewalk in town. */
  const edgeCore = new Float32Array(N * N);
  const edgeBridge = new Uint8Array(N * N);
  const touched: number[] = [];
  for (const { edge, pts, y, bridges } of shaped) {
    const half = ROAD_WIDTH[edge.type] / 2 / cell;
    const onBridge = (i: number) => bridges.some(([s, e]) => i > s && i < e);
    touched.length = 0;
    // Tunnel ends: the mountain face stays untouched beyond the portal plane (the portal is built against it).
    const ends = tunnelEnds(edge, pts, tunnels);
    pts.forEach(([px, py], i) => {
      const bridge = onBridge(i);
      // Railways run level through the land: deep cuts and high fills get wide, gentle sides.
      const depth = edge.type === 'rail' && !bridge ? Math.abs(sampleGrid(ground, N, px, py) - y[i]) : 0;
      const core = half + CORE + (edge.type === 'asphalt' && !bridge && inTown(px, py) ? TOWN_WALK / cell : 0);
      const R = core + SHOULDER + Math.min(RAIL_SLOPE_MAX, depth * RAIL_SLOPE);
      const x0 = Math.max(0, Math.floor(px - R)), x1 = Math.min(N - 1, Math.ceil(px + R));
      const y0 = Math.max(0, Math.floor(py - R)), y1 = Math.min(N - 1, Math.ceil(py + R));
      for (let j = y0; j <= y1; j++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - px, j - py);
          if (d > R || ends.some((e) => beyondPortal(e, x, j))) continue;
          const k = j * N + x;
          if (d <= half + 1) covered[k] = 1;
          if (d >= edgeDist[k]) continue;
          if (edgeDist[k] === Infinity) touched.push(k);
          edgeDist[k] = d;
          edgeY[k] = y[i];
          edgeR[k] = R;
          edgeCore[k] = core;
          edgeBridge[k] = bridge ? 1 : 0;
        }
      }
    });

    // Merge this edge into the map-wide result: nearest surface wins under roads, strongest grading on shoulders.
    for (const k of touched) {
      const d = edgeDist[k];
      edgeDist[k] = Infinity;
      if (d < dist[k]) {
        dist[k] = d;
        underBridge[k] = edgeBridge[k];
      }
      if (edgeBridge[k]) continue;
      if (d <= edgeCore[k]) {
        if (d < coreDist[k]) {
          coreDist[k] = d;
          coreY[k] = edgeY[k];
        }
        continue;
      }
      const g = lerp(ground[k], edgeY[k], 1 - smoothstep(edgeCore[k], edgeR[k], d));
      if (!(Math.abs(g - ground[k]) <= Math.abs(graded[k] - ground[k]))) graded[k] = g; // NaN compares false
    }
  }

  for (const pad of pads) {
    const R = pad.radius + PAD_BLEND;
    const x0 = Math.max(0, Math.floor(pad.x - R)), x1 = Math.min(N - 1, Math.ceil(pad.x + R));
    const y0 = Math.max(0, Math.floor(pad.y - R)), y1 = Math.min(N - 1, Math.ceil(pad.y + R));
    for (let j = y0; j <= y1; j++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - pad.x, j - pad.y);
        if (d > R) continue;
        const k = j * N + x;
        if (d <= pad.radius) {
          if (d < coreDist[k]) {
            coreDist[k] = d;
            coreY[k] = pad.height;
          }
          continue;
        }
        const g = lerp(ground[k], pad.height, 1 - smoothstep(pad.radius, R, d));
        if (!(Math.abs(g - ground[k]) <= Math.abs(graded[k] - ground[k]))) graded[k] = g;
      }
    }
  }

  for (let k = 0; k < heights.length; k++) {
    // Never fill water: river beds and shallows keep flowing under bridges.
    // Base build areas keep their levelled ground (the roads follow it there, see shapeEdge).
    if (keep[k] || underBridge[k] || heights[k] < WATER_LEVEL + 0.25) continue;
    if (coreDist[k] < Infinity) {
      heights[k] = coreY[k];
      level[k] = 1;
    } else if (!Number.isNaN(graded[k])) heights[k] = graded[k];
  }

  // Cut-and-cover: earth over each tunnel's barrel, as high as the portal, flaring and blending into the range.
  for (const { edge, pts, y } of shaped) {
    for (const plane of tunnelEnds(edge, pts, tunnels)) {
      const top = (plane[0] === pts[0][0] && plane[1] === pts[0][1] ? y[0] : y[y.length - 1]) + TUNNEL_COVER;
      coverPortal(N, cell, heights, keep, plane, ROAD_WIDTH[edge.type], top);
    }
  }
  return { covered, level };
}

/** Mound behind a portal (grid cells): full height within the headwall's width, flaring outward, then blended out. */
function coverPortal(N: number, cell: number, heights: Float32Array, keep: Uint8Array, [ex, ey, dx, dy]: PortalPlane, width: number, top: number): void {
  const half = (width + TUNNEL_SPAN_EXTRA) / 2 / cell, length = TUNNEL_BARREL / cell, blend = 5, flare = 0.7;
  const R = length + blend + half + flare * (length + blend);
  for (let j = Math.max(0, Math.floor(ey - R)); j <= Math.min(N - 1, Math.ceil(ey + R)); j++) {
    for (let x = Math.max(0, Math.floor(ex - R)); x <= Math.min(N - 1, Math.ceil(ex + R)); x++) {
      const ox = x - ex, oy = j - ey;
      const along = ox * dx + oy * dy, side = Math.abs(ox * dy - oy * dx);
      if (along <= 0) continue;
      const k = j * N + x;
      if (keep[k] || heights[k] < WATER_LEVEL + 0.25) continue;
      const w = (1 - smoothstep(length, length + blend, along)) * (1 - smoothstep(half + flare * along, half + flare * along + blend, side));
      if (w > 0) heights[k] = Math.max(heights[k], lerp(heights[k], top, w));
    }
  }
}

/** Portal plane of a tunnel end: end point and unit direction into the mountain (grid cells). */
type PortalPlane = [x: number, y: number, dx: number, dy: number];
/** Cells this close (grid cells) to a portal and past its plane are left alone (a road curving back elsewhere is not). */
const PORTAL_REACH = 16;

function tunnelEnds(edge: ShapedEdge['edge'], pts: [number, number][], tunnels: ReadonlySet<number>): PortalPlane[] {
  const ends: PortalPlane[] = [];
  if (pts.length < 2) return ends;
  const plane = (end: [number, number], prev: [number, number]) => {
    const dx = end[0] - prev[0], dy = end[1] - prev[1], l = Math.hypot(dx, dy) || 1;
    ends.push([end[0], end[1], dx / l, dy / l]);
  };
  const back = Math.min(3, pts.length - 1);
  if (tunnels.has(edge.from)) plane(pts[0], pts[back]);
  if (tunnels.has(edge.to)) plane(pts[pts.length - 1], pts[pts.length - 1 - back]);
  return ends;
}

function beyondPortal([ex, ey, dx, dy]: PortalPlane, x: number, y: number): boolean {
  const ox = x - ex, oy = y - ey;
  return ox * dx + oy * dy > 0 && ox * ox + oy * oy < PORTAL_REACH * PORTAL_REACH;
}
