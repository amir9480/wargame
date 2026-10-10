// Read-only queries over a RoadNetwork, for gameplay and AI (pathing along roads).

import type { RoadEdge, RoadNetwork, RoadNode, RoadPoint, RoadType } from './types.ts';

export interface RoadNeighbor {
  node: RoadNode;
  edge: RoadEdge;
}

export interface RoadRoute {
  /** Node ids from start to end. */
  nodes: number[];
  /** Edge ids travelled, in order. */
  edges: number[];
  /** Total length in world units. */
  length: number;
  /** Total cost (length weighted by road speed). */
  cost: number;
  /** Curve nodes of the whole route, start to end, without duplicate joints. */
  points: RoadPoint[];
}

export interface RouteOptions {
  /**
   * Relative speed per road type; cost = length / speed, 0 = not usable.
   * Default: asphalt 1.5, dirt 1, rail 0 (vehicles cross the railway at level crossings but don't drive along it;
   * a train would route with e.g. { dirt: 0, asphalt: 0, rail: 1 }).
   */
  speed?: Partial<Record<RoadType, number>>;
}

export interface NearestRoadPoint {
  edge: RoadEdge;
  /** Index of the closest curve node on the edge. */
  index: number;
  point: RoadPoint;
  /** Horizontal distance from the query position. */
  distance: number;
}

export function roadNeighbors(net: RoadNetwork, nodeId: number): RoadNeighbor[] {
  return net.nodes[nodeId].edges.map((id) => {
    const edge = net.edges[id];
    return { edge, node: net.nodes[edge.from === nodeId ? edge.to : edge.from] };
  });
}

/** An edge's curve nodes ordered to start at `fromNode`. */
export function edgePointsFrom(edge: RoadEdge, fromNode: number): RoadPoint[] {
  return edge.from === fromNode ? edge.points : [...edge.points].reverse();
}

/** Closest node with a road (not only railway) on it. */
export function nearestRoadNode(net: RoadNetwork, x: number, z: number): RoadNode | null {
  let best: RoadNode | null = null;
  let bestD = Infinity;
  for (const n of net.nodes) {
    if (n.edges.every((id) => net.edges[id].type === 'rail')) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Closest curve node on an edge of one of `types` (default: roads, not the railway). */
export function nearestRoadPoint(
  net: RoadNetwork, x: number, z: number, types: readonly RoadType[] = ['dirt', 'asphalt'],
): NearestRoadPoint | null {
  let best: NearestRoadPoint | null = null;
  for (const edge of net.edges) {
    if (!types.includes(edge.type)) continue;
    edge.points.forEach((point, index) => {
      const distance = Math.hypot(point.x - x, point.z - z);
      if (!best || distance < best.distance) best = { edge, index, point, distance };
    });
  }
  return best;
}

/** Fastest route between two nodes along the road graph (Dijkstra), or null if not connected. */
export function findRoadRoute(net: RoadNetwork, from: number, to: number, { speed = {} }: RouteOptions = {}): RoadRoute | null {
  const speedOf = (t: RoadType) => speed[t] ?? (t === 'asphalt' ? 1.5 : t === 'rail' ? 0 : 1);
  const n = net.nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const via = new Array<number>(n).fill(-1); // edge used to reach node
  const done = new Array<boolean>(n).fill(false);
  dist[from] = 0;

  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === to) break;
    done[u] = true;
    for (const { node, edge } of roadNeighbors(net, u)) {
      const v = speedOf(edge.type);
      if (v <= 0) continue;
      const d = dist[u] + edge.length / v;
      if (d < dist[node.id]) {
        dist[node.id] = d;
        via[node.id] = edge.id;
      }
    }
  }
  if (dist[to] === Infinity) return null;

  const nodes = [to];
  const edges: number[] = [];
  for (let v = to; v !== from; ) {
    const e = net.edges[via[v]];
    edges.push(e.id);
    v = e.from === v ? e.to : e.from;
    nodes.push(v);
  }
  nodes.reverse();
  edges.reverse();

  const points: RoadPoint[] = [];
  let length = 0;
  edges.forEach((id, i) => {
    const e = net.edges[id];
    length += e.length;
    const pts = edgePointsFrom(e, nodes[i]);
    points.push(...(points.length ? pts.slice(1) : pts));
  });
  if (!points.length) points.push(net.nodes[from]);
  return { nodes, edges, length, cost: dist[to], points };
}
