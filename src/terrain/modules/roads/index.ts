// Roads module: builds a road network over the finished relief + rivers.
//
//   crossings -> 2..4 planned bridge sites per river (the only places roads cross water)
//   sites     -> 0..2 map exits (through mountain passes)
//   rail      -> 0..1 railway, edge to edge (own random stream)
//   network   -> grows roads on the grid (A* / Dijkstra): base ring, exits, river crossings, railway
//   shape     -> smooth curves, surface heights, arched bridges over rivers
//   carve     -> cuts/fills the terrain under the roads

import type { Rng } from '../../../core/rng.ts';
import type { Noise2D } from '../../../core/noise.ts';
import { boxBlur, slopeField } from '../../grid.ts';
import type { PlayArea, Point, Side } from '../../types.ts';
import { TOWN_REACH } from '../../urban.ts';
import type { BaseSite, CityStreets, RoadContext } from './context.ts';
import { planCrossings } from './crossings.ts';
import { pickExits } from './sites.ts';
import { pickRail } from './rail.ts';
import { growNetwork } from './network.ts';
import { nodeHeight, railNodeHeights, shapeEdge, type ShapedEdge } from './shape.ts';
import { carveRoads, PAD_MARGIN, type RoadPad } from './carve.ts';
import { ROAD_WIDTH, type RoadEdge, type RoadNetwork, type RoadNode, type RoadPoint } from './types.ts';

export * from './types.ts';
export * from './graph.ts';
export { ASPHALT_CHANCE, MIN_BRIDGES } from './network.ts';
export { RAIL_CHANCE } from './rail.ts';

export interface RoadInput {
  N: number;
  cell: number;
  play: PlayArea;
  /** Modified in place: terrain is flattened under the roads. */
  heights: Float32Array;
  /** Height the relief's mountains add per cell: exits through a range end at a tunnel portal at its foot. */
  mountain: Float32Array;
  /** River id + 1 per cell, else 0. */
  riverMask: Uint8Array;
  /** 1 on mountain stream channels: treated as water roads can't cross. */
  streamMask: Uint8Array;
  /** River centre lines (grid), same order as Terrain.rivers. */
  riverPaths: Point[][];
  seaSides: Side[];
  /** Player bases (grid cells), in ring order. */
  bases: BaseSite[];
  /** City street grids (laid first, so the ring roads run through them). */
  cities?: CityStreets[];
}

export interface RoadResult {
  network: RoadNetwork;
  /** 1 on grid cells covered by a road, railway or bridge. */
  mask: Uint8Array;
  /** 1 on cells levelled to a road surface or junction pad (incl. town sidewalks). */
  level: Uint8Array;
}

/** `railRng` is the railway's own stream, so adding it left every road as it was. */
export function generateRoads(
  { N, cell, play, heights, mountain, riverMask, streamMask, riverPaths, seaSides, bases, cities = [] }: RoadInput, rng: Rng, noise: Noise2D, railRng: Rng,
): RoadResult {
  const near = boxBlur(Float32Array.from(riverMask), N, 4);
  const ctx: RoadContext = {
    N,
    cell,
    play,
    heights,
    mountain,
    slope: slopeField(heights, N, cell),
    riverMask,
    streamMask,
    nearRiver: Uint8Array.from(near, (v) => (v > 0 ? 1 : 0)),
    corridor: new Int16Array(N * N),
    seaSides,
    keep: baseMask(N, bases),
  };

  const plan = planCrossings(ctx, riverPaths, rng);
  ctx.corridor = plan.corridor;
  const exits = pickExits(ctx, rng);
  const rail = pickRail(ctx, railRng);
  // Exit / rail end cells that are tunnel portals (the network adds their nodes at exactly these cells).
  const tunnels = new Set([...exits, ...(rail ? [rail.from, rail.to] : [])].filter((p) => p.tunnel).map((p) => p.y * N + p.x));
  const grid = growNetwork(ctx, bases, exits, plan.crossings, rail, rng, noise, cities);
  // Node heights from the pre-carve ground (level crossings: the railway's), the same values the edge ends use.
  const railY = railNodeHeights(ctx, grid.nodes, grid.edges);
  const nodeY = grid.nodes.map((n) => railY.get(n.id) ?? nodeHeight(ctx, [n.x, n.y]));
  // Junctions and level crossings sit on a flat pad (node height), and every road / track meeting there runs level
  // across it before ramping to its own profile.
  const pads = grid.nodes.map((n, i): RoadPad | null => {
    if (n.kind !== 'junction' && n.kind !== 'crossing') return null;
    const widest = Math.max(...n.edges.map((id) => ROAD_WIDTH[grid.edges[id].type]));
    return { x: n.x, y: n.y, height: nodeY[i], radius: widest / 2 / cell + PAD_MARGIN };
  });
  const flat = (node: number) => (pads[node] ? pads[node].radius + 1 : 0);
  const shaped = grid.edges.map((e) => shapeEdge(ctx, e, [nodeY[e.from], nodeY[e.to]], [flat(e.from), flat(e.to)]));
  // Town reach as urban.ts `townAt` measures it (grid cells here), so the levelled width matches the sidewalks drawn.
  const inTown = (x: number, y: number) => cities.some((c) => Math.hypot(x - c.x, y - c.y) < c.radius * TOWN_REACH);
  const isTunnel = (n: (typeof grid.nodes)[number]) => n.kind === 'exit' && tunnels.has(Math.round(n.y) * N + Math.round(n.x));
  const tunnelNodes = new Set(grid.nodes.filter(isTunnel).map((n) => n.id));
  const { covered: mask, level } = carveRoads(ctx, shaped, pads.filter((p) => p !== null), inTown, tunnelNodes);

  const half = ((N - 1) * cell) / 2;
  const nodes: RoadNode[] = grid.nodes.map((n, i) => ({
    id: n.id,
    kind: n.kind,
    ...(tunnelNodes.has(n.id) ? { tunnel: true } : {}),
    edges: n.edges.slice(),
    x: n.x * cell - half,
    y: nodeY[i],
    z: n.y * cell - half,
  }));
  const edges: RoadEdge[] = shaped.map((s) => toWorldEdge(s, cell, half));
  return { network: { nodes, edges }, mask, level };
}

function toWorldEdge({ edge, pts, y, bridges, rivers }: ShapedEdge, cell: number, half: number): RoadEdge {
  const points: RoadPoint[] = pts.map(([px, py], i) => ({ x: px * cell - half, y: y[i], z: py * cell - half }));
  const dist = (a: RoadPoint, b: RoadPoint) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    width: ROAD_WIDTH[edge.type],
    points,
    length,
    bridges: bridges.map(([start, end], i) => ({ start, end, length: dist(points[start], points[end]), river: rivers[i] })),
  };
}

/** Cells of the base build areas (square of half side `half` around each centre). */
function baseMask(N: number, bases: BaseSite[]): Uint8Array {
  const mask = new Uint8Array(N * N);
  for (const b of bases)
    for (let j = Math.max(0, Math.ceil(b.y - b.half)); j <= Math.min(N - 1, Math.floor(b.y + b.half)); j++)
      for (let i = Math.max(0, Math.ceil(b.x - b.half)); i <= Math.min(N - 1, Math.floor(b.x + b.half)); i++) mask[j * N + i] = 1;
  return mask;
}
