// Road network growth on the grid, planned around the player bases.
//
// 0. Cities: their street grids are laid first (straight asphalt streets between crossings), so the
//    routes below can follow them (cheap reuse) and the ring roads run through the towns.
// 1. Ring: each base is connected to its two neighbours around the map (red ->
//    green -> blue -> purple -> red), so every player gets the same kind of road
//    access. Routes reuse existing road where that is cheaper; where a route leaves
//    or rejoins a road a junction is made, so roads merge instead of running side
//    by side, and never cross without a junction.
//    Each city is then joined to its two nearest bases (along existing roads where it can).
// 2. Exits: 0..2 roads from outside the map, each joined to the nearest road.
// 3. Rivers: a river crossed by fewer than MIN_BRIDGES roads gets roads over its
//    planned crossings until it has them.
// 4. Any piece cut off from the rest is joined to the main network.
// 5. Dead ends (street ends left by the town grids): each is linked straight on to a road just ahead (two facing
//    dead ends merge into one street), else dropped when short.
// 6. Railway (if the map has one), routed around the finished roads: it may bridge
//    any river (not where a road bridge already is) and crosses roads only at level
//    crossings away from road nodes and water, splitting both into a crossing node.
//
// Rivers can only be crossed inside planned crossing corridors, one road each.

import type { Rng } from '../../../core/rng.ts';
import type { Noise2D } from '../../../core/noise.ts';
import { findPath } from '../../pathfind.ts';
import { WATER_LEVEL, type GridPoint, type Point } from '../../types.ts';
import type { Crossing } from './crossings.ts';
import type { RoadType } from './types.ts';
import type { BaseSite, CityStreets, GridEdge, GridNode, RoadContext } from './context.ts';
import { smoothPath } from './shape.ts';
import { MAX_EXITS, approachPoints, routeStart, type ExitSite } from './sites.ts';
import { TOWN_REACH } from '../../urban.ts';
import {
  RAIL_BASE_MARGIN, RAIL_CROSS_COS, RAIL_MAX_GRADE, RAIL_MIN_RADIUS, RAIL_NODE_CLEARANCE, RAIL_ROAD_COST, type RailPlan,
} from './rail.ts';

/** Chance the base ring roads are asphalt; exit and crossing roads are dirt. */
export const ASPHALT_CHANCE = 0.4;
/** Every river gets at least this many bridges (if it has that many crossing sites). */
export const MIN_BRIDGES = 2;
/** Steepest grade a road may climb (rise / run). */
const MAX_GRADE = 0.3;
/** Cost per water cell inside a crossing corridor (bridge deck). */
const BRIDGE_COST = 2;
/** Cost factor for following an existing road (so routes merge instead of running in parallel). */
const REUSE = 0.35;
/** Joins this close (in curve points, ~1 cell each) to an edge's end snap to its end node. */
const SNAP = 7;
/** A crossing road's second bank joins at least this far from where its first bank joined (no loops). */
const MIN_SPUR = 40;
/** Cells a new road keeps from roads it may not join (owned cells already span ±1). */
const CLEARANCE = 2;
/** Cells around a base's build area that other bases' ring roads keep out of. */
const BASE_MARGIN = 3;
/** A dead end links on to a road at most this far ahead (cells), within LINK_COS of straight on. */
const LINK_REACH = 18;
const LINK_COS = 0.5;
/** Roads closer than this (cells, about a street's paved width) to a dead end always join it, unless behind it. */
const LINK_CLOSE = 8;
const LINK_CLOSE_COS = -0.2;
/** A link joining an edge midway meets it at least this steeply (|cos| of the angle between them). */
const LINK_MEET_COS = 0.82;
/** Cells around both link ends where it may touch other roads (the ones meeting there). */
const LINK_END_ZONE = 4;
/** Dead ends shorter than this (cells) with nothing to link to are dropped. */
const MIN_DEAD_END = 15;
/** Town junctions closer than this (cells, along the street between them) merge into one. */
const MIN_JUNCTION_GAP = 15;
/** Two roads between the same town junctions closer than this (cells) somewhere along the way: one is dropped. */
const TWIN_GAP = 7;
/** Cells beyond a town's reach where a dirt road meeting a town street changes to asphalt. */
const PAVE_MARGIN = 4;
/** Points either side of a dissolved two-road join that are re-smoothed. */
const JOIN_SMOOTH = 10;
/** Roads leave a 3- / 4-way junction straight for this many cells (past its crosswalks). */
const ARM_STRAIGHT = 8;
/** Most roads meeting at a node a link may join (junction plates draw up to 4). */
const MAX_ARMS = 4;

export interface GridNetwork {
  nodes: GridNode[];
  edges: GridEdge[];
}

/**
 * @param bases player bases, in ring order (slots 0..3)
 * @param exits map-edge points where roads enter from outside
 * @param rail railway end points, or null for none
 * @param cities city street grids (none: the network is exactly as without cities)
 */
export function growNetwork(
  ctx: RoadContext, bases: BaseSite[], exits: ExitSite[], crossings: Crossing[], rail: RailPlan | null, rng: Rng, noise: Noise2D,
  cities: CityStreets[] = [],
): GridNetwork {
  const { N } = ctx;
  const baseCost = makeCost(ctx, noise);
  const rescueCost = makeCost(ctx, noise, true);
  const crossingCount = crossings.length;
  let extraCrossings = 0;
  const isWater = (k: number) => ctx.heights[k] < WATER_LEVEL + 0.25 || ctx.riverMask[k] > 0 || ctx.streamMask[k] > 0;
  // Each crossing carries one road: once used, its water is closed to further routes.
  const usedCrossings = new Set<number>();
  const cost = (a: number, b: number, diagonal: boolean): number =>
    ctx.corridor[b] && usedCrossings.has(ctx.corridor[b] - 1) && isWater(b) ? Infinity : baseCost(a, b, diagonal);
  const markUsed = (cells: number[]): void => {
    for (const k of cells) if (ctx.corridor[k] && isWater(k)) usedCrossings.add(ctx.corridor[k] - 1);
  };
  const nodes: GridNode[] = [];
  const edges: GridEdge[] = [];
  const owner = new Int32Array(N * N).fill(-1);
  const ownerIdx = new Int32Array(N * N);
  const cellAt = (x: number, y: number): number => {
    const cx = Math.round(x), cy = Math.round(y);
    return cx < 0 || cy < 0 || cx >= N || cy >= N ? -1 : cy * N + cx;
  };
  const water = (x: number, y: number): boolean => {
    const k = cellAt(x, y);
    return k >= 0 && isWater(k);
  };
  const cellsOf = (pts: Point[]) => pts.map(([x, y]) => cellAt(x, y)).filter((k) => k >= 0);
  // Smoothing may not move a road onto water, except across a planned crossing.
  const blocked = (x: number, y: number): boolean => water(x, y) && !ctx.corridor[cellAt(x, y)];
  const addNode = (x: number, y: number, kind: GridNode['kind']): number => {
    nodes.push({ id: nodes.length, x, y, kind, edges: [] });
    return nodes.length - 1;
  };
  /** Edge with an already smoothed centre line. */
  const pushEdge = (from: number, to: number, type: RoadType, pts: Point[]): void => {
    const id = edges.length;
    edges.push({ id, from, to, type, pts });
    markUsed(cellsOf(pts));
    nodes[from].edges.push(id);
    nodes[to].edges.push(id);
  };
  const addEdge = (from: number, to: number, type: RoadType, raw: Point[]): void => pushEdge(from, to, type, smoothPath(raw, blocked));
  // Mark cells within 1 of every road point (so diagonal paths can't slip through).
  const rasterize = (): void => {
    owner.fill(-1);
    for (const e of edges) {
      e.pts.forEach(([px, py], i) => {
        const x = Math.round(px), y = Math.round(py);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const cx = x + dx, cy = y + dy;
            if (cx < 0 || cy < 0 || cx >= N || cy >= N) continue;
            const k = cy * N + cx;
            if (owner[k] < 0) {
              owner[k] = e.id;
              ownerIdx[k] = i;
            }
          }
      });
    }
  };
  const onNetwork = (c: number) => owner[c] >= 0 && dryAround(ctx, edges[owner[c]].pts[ownerIdx[c]]);

  // 1. Ring between the bases.
  const ringType: RoadType = rng() < ASPHALT_CHANCE ? 'asphalt' : 'dirt';
  const baseNodes = bases.map((b) => addNode(b.x, b.y, 'base'));
  // 0. City streets (base nodes stay the first ids).
  const cityNodes = cities.map((city) => {
    const ids = city.nodes.map(([x, y]) => addNode(x, y, 'junction'));
    for (const [p, q] of city.streets) pushEdge(ids[p], ids[q], 'asphalt', straight(city.nodes[p], city.nodes[q]));
    return ids;
  });
  if (cities.length) rasterize();
  // Base node id whose build area (plus a margin) covers each cell, else -1.
  const baseAt = new Int16Array(N * N).fill(-1);
  bases.forEach((b, n) => {
    const r = Math.ceil(b.half) + BASE_MARGIN;
    for (let y = Math.max(0, Math.round(b.y) - r); y <= Math.min(N - 1, Math.round(b.y) + r); y++)
      for (let x = Math.max(0, Math.round(b.x) - r); x <= Math.min(N - 1, Math.round(b.x) + r); x++) baseAt[y * N + x] = baseNodes[n];
  });
  const pairs = bases.length > 2
    ? baseNodes.map((n, i) => [n, baseNodes[(i + 1) % baseNodes.length]])
    : baseNodes.length === 2 ? [[baseNodes[0], baseNodes[1]]] : [];
  // Neighbours never route through a third base: going via it would leave every
  // base up to two bases away from its neighbour instead of at most one.
  for (const [a, b] of pairs) route(a, b, ringType, true) || route(a, b, ringType, false);
  // Each city joins its two nearest bases, from its street crossing nearest to each.
  cities.forEach((city, c) => {
    const dist = (n: number, x: number, y: number) => Math.hypot(nodes[n].x - x, nodes[n].y - y);
    const near = baseNodes.slice().sort((p, q) => dist(p, city.x, city.y) - dist(q, city.x, city.y)).slice(0, 2);
    for (const b of near) {
      const ids = cityNodes[c].filter((n) => nodes[n].edges.length);
      if (!ids.length) continue;
      const start = ids.reduce((s, n) => (dist(n, nodes[b].x, nodes[b].y) < dist(s, nodes[b].x, nodes[b].y) ? n : s));
      route(start, b, 'asphalt', true) || route(start, b, 'asphalt', false);
    }
  });

  // 2. Exits: roads in from outside the map.
  for (const ex of exits) {
    const from = routeStart(ex);
    const start = from.y * N + from.x;
    if (owner[start] >= 0) continue; // a road already reaches the edge here
    const path = edges.length ? findPath({ N, start, cost, isGoal: onNetwork }) : null;
    if (!path) continue;
    const contact = path[path.length - 1];
    const j = nodes[joinAt(owner[contact], ownerIdx[contact])];
    const pts = [...approachPoints(ex), ...toPoints(path, N)]; // tunnels: straight out of the portal first
    pts[pts.length - 1] = [j.x, j.y];
    addEdge(addNode(ex.x, ex.y, 'exit'), j.id, 'dirt', pts);
    rasterize();
  }

  // 3. Rivers with too few bridges get roads over their planned crossings.
  const bridgesOn = (river: number) => crossings.filter((c) => c.river === river && usedCrossings.has(c.id)).length;
  for (const c of crossings) {
    if (usedCrossings.has(c.id) || bridgesOn(c.river) >= MIN_BRIDGES) continue;
    // Each bank connects without using this crossing (other crossings are fine).
    // Leave each approach point away from the river: the corridor between the approach
    // points is off limits (re-entering it would make the road double back onto itself).
    const [cx, cy] = c.center;
    const reach = Math.min(Math.hypot(c.approachA.x - cx, c.approachA.y - cy), Math.hypot(c.approachB.x - cx, c.approachB.y - cy));
    const avoid = (a: number, b: number, d: boolean) => {
      if (ctx.corridor[b] !== c.id + 1) return cost(a, b, d);
      const x = b % N, y = (b - x) / N;
      return Math.hypot(x - cx, y - cy) < reach - 0.5 ? Infinity : cost(a, b, d);
    };
    const endA = connectBank(c.approachA, avoid);
    if (!endA) continue;
    markUsed(cellsOf(endA.path)); // B's leg may not reuse a crossing A's leg already took
    // Bank B must join somewhere else, or the road would just loop back to A's junction.
    const endB = connectBank(c.approachB, avoid, nodes[endA.node]);
    if (!endB || endB.node === endA.node) continue;
    // junction A -> approach A -> bank A -> (bridge) -> bank B -> approach B -> junction B
    const bridge: Point[] = [[c.a.x, c.a.y], [c.b.x, c.b.y]];
    addEdge(endA.node, endB.node, 'dirt', [...endA.path, ...bridge, ...endB.path.reverse()]);
    rasterize();
  }

  // 4. Any piece of road cut off from the rest is joined to the main network.
  for (let tries = 0; tries < 8; tries++) {
    const comp = components();
    const main = comp[0];
    const loose = nodes.filter((n) => comp[n.id] !== main && n.edges.length);
    if (!loose.length) break;
    const toMain = (c: number) => onNetwork(c) && comp[edges[owner[c]].from] === main;
    // Last resort may bridge a river anywhere, but never parallel to a used bridge.
    const rescue = (a: number, b: number, d: boolean) =>
      ctx.corridor[b] && usedCrossings.has(ctx.corridor[b] - 1) && isWater(b) ? Infinity : rescueCost(a, b, d);
    // Try the loose nodes nearest to the main network first.
    const mainEdges = edges.filter((e) => comp[e.from] === main);
    loose.sort((p, q) => distToNetwork(p, mainEdges) - distToNetwork(q, mainEdges));
    let joined = false;
    for (const n of loose) {
      const path = findPath({ N, start: cellAt(n.x, n.y), cost, isGoal: toMain })
        ?? findPath({ N, start: cellAt(n.x, n.y), cost: rescue, isGoal: toMain });
      if (!path || path.length < 2) continue;
      // Any water the path crosses becomes a crossing corridor, so smoothing keeps the bridge.
      const extra = crossingCount + ++extraCrossings;
      for (const k of path) if (isWater(k) && !ctx.corridor[k]) ctx.corridor[k] = extra;
      const contact = path[path.length - 1];
      const j = nodes[joinAt(owner[contact], ownerIdx[contact])];
      const pts = toPoints(path, N);
      pts[0] = [n.x, n.y];
      pts[pts.length - 1] = [j.x, j.y];
      addEdge(n.id, j.id, 'dirt', pts);
      rasterize();
      joined = true;
      break;
    }
    if (!joined) break;
  }

  // 5. Clean topology before anything is shaped or drawn: dead ends, town junctions too close together, then every
  //    junction becomes either a plain join (two roads: one continuous edge) or a 3- / 4-way intersection whose arms
  //    leave it straight.
  tidyDeadEnds();
  mergeCloseJunctions();
  dissolveJoins();
  straightenArms();
  dropRemovedEdges();

  // 6. Railway.
  if (rail) buildRail(rail);

  // Drop nodes left without roads (an exit made for a crossing that could not be
  // completed), renumbering the rest. Base nodes stay first, in slot order.
  const kept = nodes.filter((n) => n.edges.length || n.kind === 'base');
  const newId = new Map(kept.map((n, i) => [n.id, i]));
  kept.forEach((n, i) => (n.id = i));
  for (const e of edges) {
    e.from = newId.get(e.from)!;
    e.to = newId.get(e.to)!;
  }
  return { nodes: kept, edges };

  /**
   * Road between nodes a and b. The route may follow existing roads (cheaper); only
   * the stretches off existing road become new edges, joined where they meet a road.
   * With `avoidBases` it may not pass through any other base. False if no route.
   */
  function route(a: number, b: number, type: RoadType, avoidBases: boolean): boolean {
    const A = nodes[a], B = nodes[b];
    const goal = cellAt(B.x, B.y);
    const reuse = (x: number, y: number, d: boolean): number => {
      if (y === goal) return cost(x, y, d);
      if (avoidBases && baseAt[y] >= 0 && baseAt[y] !== a && baseAt[y] !== b) return Infinity;
      // On existing road: cheap where junctions are allowed, never next to water/bridges.
      if (owner[y] >= 0) return onNetwork(y) ? (d ? Math.SQRT2 : 1) * REUSE : Infinity;
      return cost(x, y, d);
    };
    const path = findPath({
      N,
      start: cellAt(A.x, A.y),
      cost: reuse,
      isGoal: (c) => c === goal,
      heuristic: (c) => {
        const dx = Math.abs((c % N) - B.x), dy = Math.abs(Math.floor(c / N) - B.y);
        return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * REUSE; // admissible
      },
    });
    if (!path) return false;

    // Split into off-road stretches; each becomes an edge between its two anchor nodes.
    let from: number | null = a;
    let fromIdx = 0;
    const last = path.length - 1;
    for (let k = 1; k <= last; k++) {
      const c = path[k];
      if (k === last) {
        if (from !== null) stretch(from, fromIdx, b, k);
        break;
      }
      if (owner[c] >= 0) {
        if (from !== null) {
          // Reached an existing road: join it here.
          const j = joinAt(owner[c], ownerIdx[c]);
          rasterize();
          stretch(from, fromIdx, j, k);
          from = null;
        }
      } else if (from === null) {
        // Leaving an existing road: the new stretch starts from a junction on it.
        const prev = path[k - 1];
        from = joinAt(owner[prev], ownerIdx[prev]);
        rasterize();
        fromIdx = k - 1;
      }
    }

    function stretch(n1: number, i0: number, n2: number, i1: number): void {
      if (n1 === n2) return;
      const pts = toPoints(path!.slice(i0, i1 + 1), N);
      pts[0] = [nodes[n1].x, nodes[n1].y];
      pts[pts.length - 1] = [nodes[n2].x, nodes[n2].y];
      addEdge(n1, n2, type, pts);
      rasterize();
    }
    return true;
  }

  /** Connected-component label per node (union-find over edges). */
  function components(): number[] {
    const parent = nodes.map((n) => n.id);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const e of edges) parent[find(e.from)] = find(e.to);
    return nodes.map((n) => find(n.id));
  }

  /**
   * Road from a crossing bank to the network (joining it), or, failing that, off
   * the nearest map edge (new exit). Returns the end node and the raw path from
   * that node to the bank.
   */
  function connectBank(bank: GridPoint, stepCost: typeof cost, awayFrom?: GridNode): { node: number; path: Point[] } | null {
    const start = bank.y * N + bank.x;
    const farEnough = (c: number) => !awayFrom || Math.hypot((c % N) - awayFrom.x, Math.floor(c / N) - awayFrom.y) > MIN_SPUR + 6;
    const joinable = (c: number) => onNetwork(c) && farEnough(c);
    if (edges.length) {
      const path = findPath({ N, start, cost: awayFrom ? keepClear(stepCost, start, joinable) : stepCost, isGoal: joinable });
      if (path) {
        const contact = path[path.length - 1];
        const j = nodes[joinAt(owner[contact], ownerIdx[contact])];
        rasterize();
        const pts = toPoints(path, N).reverse(); // contact -> bank
        if (pts.length > 1) pts[0] = [j.x, j.y];
        else pts.unshift([j.x, j.y]);
        return { node: j.id, path: pts };
      }
    }
    const border = (k: number) => {
      const x = k % N, y = (k - x) / N;
      return (x === 0 || y === 0 || x === N - 1 || y === N - 1) && ctx.heights[k] >= WATER_LEVEL + 1;
    };
    // Off the map edge only while the map still has fewer than MAX_EXITS roads from outside.
    if (nodes.filter((n) => n.kind === 'exit').length >= MAX_EXITS) return null;
    const path = findPath({ N, start, cost: keepClear(stepCost, start, () => false), isGoal: border });
    if (!path) return null;
    const end = path[path.length - 1];
    const exit = addNode(end % N, Math.floor(end / N), 'exit');
    return { node: exit, path: toPoints(path, N).reverse() };
  }

  /**
   * Step cost that keeps a new road off and away from (within CLEARANCE of) any road
   * it may not join there, so it can't run alongside or across it. Cells near the
   * start are exempt (a bank or junction may sit right next to a road).
   */
  function keepClear(stepCost: typeof cost, start: number, joinable: (c: number) => boolean): typeof cost {
    const sx = start % N, sy = (start - sx) / N;
    return (a, b, d) => {
      const x = b % N, y = (b - x) / N;
      if (Math.max(Math.abs(x - sx), Math.abs(y - sy)) > CLEARANCE + 1 && !joinable(b)) {
        for (let j = Math.max(0, y - CLEARANCE); j <= Math.min(N - 1, y + CLEARANCE); j++)
          for (let i = Math.max(0, x - CLEARANCE); i <= Math.min(N - 1, x + CLEARANCE); i++) {
            const c = j * N + i;
            if (owner[c] >= 0 && !joinable(c)) return Infinity;
          }
      }
      return stepCost(a, b, d);
    };
  }

  /** Node where a branch joins edge `id` at point `t`: an existing end node, or a new junction splitting the edge. */
  function joinAt(id: number, t: number): number {
    const e = edges[id];
    // Snap to a nearby end node, but never across a bridge (that node is on the other bank).
    const dryTo = (from: number, to: number) => e.pts.slice(from, to + 1).every(([x, y]) => !water(x, y));
    // Only snap very close: a farther end node would make the new road double back
    // over this one (two roads side by side) instead of branching off it.
    if (t < SNAP && dryTo(0, t)) return e.from;
    if (t >= e.pts.length - SNAP && dryTo(t, e.pts.length - 1)) return e.to;
    return splitEdge(id, t, 'junction');
  }

  /** Splits edge `id` at point `t` into two edges meeting at a new node; returns the node. */
  function splitEdge(id: number, t: number, kind: GridNode['kind']): number {
    const e = edges[id];
    const [x, y] = e.pts[t];
    const node = addNode(x, y, kind);
    const tail: GridEdge = { id: edges.length, from: node, to: e.to, type: e.type, pts: e.pts.slice(t) };
    edges.push(tail);
    const end = nodes[e.to];
    end.edges[end.edges.indexOf(e.id)] = tail.id;
    e.pts = e.pts.slice(0, t + 1);
    e.to = node;
    nodes[node].edges.push(e.id, tail.id);
    return node;
  }

  /**
   * Step 5: every dry dead-end junction is linked straight on to the best road ahead (another dead end facing it:
   * both streets merge into one; else an end node with a free arm or a point midway along an edge, met steeply);
   * failing that it is dropped if shorter than MIN_DEAD_END. Repeated while that leaves new dead ends.
   */
  function tidyDeadEnds(): void {
    const isDead = (n: GridNode) => n.kind === 'junction' && n.edges.length === 1;
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const n of nodes) {
        if (!isDead(n)) continue;
        const e = edges[n.edges[0]];
        if (e.type === 'rail' || e.from === e.to || e.pts.some(([x, y]) => water(x, y))) continue;
        if (e.from === n.id) reverseEdge(e); // e ends at n
        if (nodes[e.from].edges.length === 1) continue; // an isolated piece: leave it
        if (linkDeadEnd(n, e)) changed = true;
        else if (polyLength(e.pts) < MIN_DEAD_END) {
          for (const end of [e.from, e.to]) nodes[end].edges = nodes[end].edges.filter((id) => id !== e.id);
          e.pts = [];
          changed = true;
        } else continue;
        rasterize();
      }
      if (!changed) break;
    }

    /** Links dead end `n` (end of edge `e`) to the best road ahead; false if there is none. */
    function linkDeadEnd(n: GridNode, e: GridEdge): boolean {
      const P = e.pts[e.pts.length - 1];
      const dir = unit(P, e.pts[Math.max(0, e.pts.length - 4)]);
      type Target = { score: number; Q: Point; f: GridEdge; t: number };
      const cands: Target[] = [];
      for (const f of edges) {
        if (f === e || !f.pts.length || f.type === 'rail') continue;
        // Nearest point of f ahead of the dead end.
        let best: Target | null = null;
        f.pts.forEach((Q, t) => {
          const d = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
          if (d > LINK_REACH) return;
          // Close by (not a road from this street's own start), anything but backwards will do.
          const close = d < LINK_CLOSE && f.from !== e.from && f.to !== e.from;
          if (d >= 1 && ((Q[0] - P[0]) * dir[0] + (Q[1] - P[1]) * dir[1]) / d < (close ? LINK_CLOSE_COS : LINK_COS)) return;
          if (!best || d < best.score) best = { score: d, Q, f, t };
        });
        if (best) cands.push(best);
      }
      for (const c of cands.sort((a, b) => a.score - b.score)) {
        const { f } = c;
        const last = f.pts.length - 1;
        const endNode = c.t <= 3 ? nodes[f.from] : c.t >= last - 3 ? nodes[f.to] : null;
        if (endNode) {
          const Q: Point = [endNode.x, endNode.y];
          if (isDead(endNode) && endNode !== n) {
            // Facing dead end: both streets become one (not a loop back to the same node).
            if (f.to !== endNode.id) reverseEdge(f);
            if (f.from === e.from) continue;
            const back = unit(Q, f.pts[Math.max(0, f.pts.length - 4)]);
            const gap = Math.hypot(P[0] - Q[0], P[1] - Q[1]);
            if (gap >= LINK_CLOSE && (P[0] - Q[0]) * back[0] + (P[1] - Q[1]) * back[1] < -0.17 * gap) continue;
            if (!clearLink(P, Q)) continue;
            // Ends that meet at an angle are cut back to where their lines cross (no hook past the corner).
            const X = gap < LINK_CLOSE ? lineHit(P, dir, Q, back) : null;
            const corner = X && Math.hypot(X[0] - P[0], X[1] - P[1]) < LINK_CLOSE && Math.hypot(X[0] - Q[0], X[1] - Q[1]) < LINK_CLOSE;
            const raw = corner
              ? [...trimPast(e.pts, X, dir), X, ...trimPast(f.pts, X, back).reverse()]
              : [...e.pts, ...straight(P, Q).slice(1, -1), ...f.pts.slice().reverse()];
            const other = nodes[f.from];
            other.edges[other.edges.indexOf(f.id)] = e.id;
            n.edges = [];
            endNode.edges = [];
            f.pts = [];
            e.to = other.id;
            if (f.type === 'asphalt') e.type = 'asphalt';
            e.pts = endsAt(smoothPath(raw, blocked), nodes[e.from], other);
            return true;
          }
          if (endNode.kind !== 'junction' || endNode.edges.length >= MAX_ARMS || endNode.id === e.from || !clearLink(P, Q)) continue;
          joinTo(n, e, endNode);
          return true;
        }
        // Midway along f, met steeply, on dry ground.
        const tan = unit(f.pts[Math.min(last, c.t + 2)], f.pts[Math.max(0, c.t - 2)]);
        const link = unit(c.Q, P);
        if (Math.abs(link[0] * tan[0] + link[1] * tan[1]) > LINK_MEET_COS || !dryAround(ctx, c.Q) || !clearLink(P, c.Q)) continue;
        joinTo(n, e, nodes[splitEdge(f.id, c.t, 'junction')]);
        return true;
      }
      return false;
    }

    /** Dead-end edge `e` (ending at `n`) runs on to node `m`. */
    function joinTo(n: GridNode, e: GridEdge, m: GridNode): void {
      const raw = [...e.pts, ...straight(e.pts[e.pts.length - 1], [m.x, m.y]).slice(1)];
      n.edges = [];
      e.to = m.id;
      m.edges.push(e.id);
      e.pts = endsAt(smoothPath(raw, blocked), nodes[e.from], m);
    }

    /** Straight link P -> Q: dry, outside the bases, within the grade limit, clear of roads away from its ends. */
    function clearLink(P: Point, Q: Point): boolean {
      const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
      const steps = Math.max(1, Math.ceil(len * 2));
      let prev = -1;
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const k = cellAt(P[0] + (Q[0] - P[0]) * u, P[1] + (Q[1] - P[1]) * u);
        if (k < 0 || isWater(k) || ctx.keep[k]) return false;
        if (prev >= 0 && k !== prev) {
          const run = Math.hypot((k % N) - (prev % N), Math.floor(k / N) - Math.floor(prev / N)) * ctx.cell;
          if (Math.abs(ctx.heights[k] - ctx.heights[prev]) > MAX_GRADE * run) return false;
        }
        if (owner[k] >= 0 && u * len > LINK_END_ZONE && (1 - u) * len > LINK_END_ZONE) return false;
        prev = k;
      }
      return true;
    }
  }

  /**
   * Town junctions joined by an edge shorter than MIN_JUNCTION_GAP (a route that met a street just beside a grid
   * crossing) merge into one: their junction plates and crosswalks would overlap. The node kept is the one that moves
   * fewer roads (tie: the older, i.e. the street grid's). At the dropped node, the road running straight on takes over
   * the short edge; every other road there is cut back and re-aimed at the kept node.
   */
  /** Inside a town's street-furniture reach (same as urban.ts townAt), plus `margin` cells. */
  function inTownAt([x, y]: Point, margin = 0): boolean {
    return cities.some((c) => Math.hypot(x - c.x, y - c.y) < c.radius * TOWN_REACH + margin);
  }

  function mergeCloseJunctions(): void {
    const inTown = (n: GridNode) => inTownAt([n.x, n.y]);
    const failed = new Set<GridEdge>();
    dropTwins();
    for (;;) {
      let best: GridEdge | null = null, bestLen = MIN_JUNCTION_GAP;
      for (const e of edges) {
        if (!e.pts.length || e.type === 'rail' || e.from === e.to || failed.has(e)) continue;
        const a = nodes[e.from], b = nodes[e.to];
        if (a.kind !== 'junction' || b.kind !== 'junction' || !(inTown(a) || inTown(b))) continue;
        const len = polyLength(e.pts);
        if (len < bestLen) [best, bestLen] = [e, len];
      }
      if (!best) break;
      if (contract(best, bestLen)) rasterize();
      else failed.add(best);
    }
    dropTwins(); // merges can make new ones

    /** Two roads between the same town junctions running side by side: the dirt / longer one goes. */
    function dropTwins(): void {
      for (const e of edges) {
        if (!e.pts.length || e.type === 'rail' || !(inTown(nodes[e.from]) || inTown(nodes[e.to]))) continue;
        for (const f of edges) {
          if (f === e || !f.pts.length || f.type === 'rail') continue;
          if (!((f.from === e.from && f.to === e.to) || (f.from === e.to && f.to === e.from))) continue;
          const ends = [nodes[e.from], nodes[e.to]];
          const zone = Math.min(LINK_END_ZONE, polyLength(e.pts) / 3); // short duplicates count too
          const beside = e.pts.some(([x, y]) => ends.every((n) => Math.hypot(x - n.x, y - n.y) > zone)
            && f.pts.some(([u, v]) => Math.hypot(u - x, v - y) < TWIN_GAP));
          if (!beside) continue;
          const worse = f.type !== e.type ? (f.type === 'dirt' ? f : e) : polyLength(f.pts) > polyLength(e.pts) ? f : e;
          for (const n of ends) n.edges = n.edges.filter((id) => id !== worse.id);
          worse.pts = [];
          if (worse === e) break;
        }
      }
      rasterize();
    }

    /** Outward direction of edge `g` at its end node `n`. */
    function outOf(g: GridEdge, n: GridNode): Point {
      const pts = g.from === n.id ? g.pts : g.pts.slice().reverse();
      return unit(pts[Math.min(3, pts.length - 1)], pts[0]);
    }

    function contract(e: GridEdge, len: number): boolean {
      const a = nodes[e.from], b = nodes[e.to];
      if (a.edges.length + b.edges.length - 2 > MAX_ARMS || e.pts.some(([x, y]) => water(x, y))) return false;
      /** Roads at `drop` if it merges into `keep`: the one running straight on, and the ones to re-aim. */
      const plan = (keep: GridNode, drop: GridNode) => {
        const back = outOf(e, drop);
        const others = drop.edges.filter((id) => id !== e.id);
        let cont = -1, bestCos = -0.85;
        for (const id of others) {
          const o = outOf(edges[id], drop), c = o[0] * back[0] + o[1] * back[1];
          if (c < bestCos) [cont, bestCos] = [id, c];
        }
        return { keep, drop, cont, moved: others.filter((id) => id !== cont) };
      };
      const pa = plan(a, b), pb = plan(b, a);
      const { keep, drop, cont, moved } = pb.moved.length < pa.moved.length || (pb.moved.length === pa.moved.length && b.id < a.id) ? pb : pa;
      const otherEnd = (g: GridEdge) => (g.from === drop.id ? g.to : g.from);
      if (cont >= 0 && otherEnd(edges[cont]) === keep.id) return false;
      // A second road between the two nodes (a small loop) goes with the merge, if it is short too.
      const twins = moved.filter((id) => otherEnd(edges[id]) === keep.id);
      if (twins.some((id) => edges[id].type === 'rail' || polyLength(edges[id].pts) > 3 * MIN_JUNCTION_GAP)) return false;
      // Re-aimed roads: cut back by the merge distance, then straight on to the kept node (dry).
      const tails = new Map<number, Point[]>();
      for (const id of moved) {
        if (twins.includes(id)) continue;
        const h = edges[id];
        if (h.type === 'rail' || polyLength(h.pts) < len + 2) return false;
        const pts = h.to === drop.id ? h.pts : h.pts.slice().reverse();
        let n = pts.length;
        while (n > 2 && Math.hypot(pts[n - 1][0] - drop.x, pts[n - 1][1] - drop.y) < len) n--;
        const tail = straight(pts[n - 1], [keep.x, keep.y]).slice(1);
        if (tail.some(([x, y]) => water(x, y))) return false;
        tails.set(id, [...pts.slice(0, n), ...tail]);
      }

      if (e.from !== keep.id) reverseEdge(e);
      keep.edges = keep.edges.filter((id) => id !== e.id);
      if (cont >= 0) {
        const g = edges[cont];
        if (g.from !== drop.id) reverseEdge(g);
        g.pts = [...e.pts, ...g.pts.slice(1)];
        g.from = keep.id;
        keep.edges.push(g.id);
      }
      for (const [id, raw] of tails) {
        const h = edges[id];
        if (h.to !== drop.id) reverseEdge(h);
        h.to = keep.id;
        h.pts = endsAt(smoothPath(raw, blocked), nodes[h.from], keep);
        keep.edges.push(h.id);
      }
      for (const id of twins) {
        keep.edges = keep.edges.filter((k) => k !== id);
        edges[id].pts = [];
      }
      drop.edges = [];
      e.pts = [];
      return true;
    }
  }

  /**
   * A junction where just two roads of one type meet is no intersection: the two edges become one continuous edge
   * (re-smoothed around the old node, so a bend is a curve, not a corner).
   */
  function dissolveJoins(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const n of nodes) {
        if (n.kind !== 'junction' || n.edges.length !== 2) continue;
        const [e, f] = n.edges.map((id) => edges[id]);
        if (e === f || e.type === 'rail' || f.type === 'rail') continue;
        // A dirt road meeting a town street is paved up to the town's edge, so the surface changes out there.
        if (e.type !== f.type && inTownAt([n.x, n.y])) pave(n, e.type === 'dirt' ? e : f);
        if (e.type !== f.type) continue;
        if (e.to !== n.id) reverseEdge(e);
        if (f.from !== n.id) reverseEdge(f);
        if (e.from === f.to) continue; // would close a loop on one node
        const joint = e.pts.length - 1;
        const pts = [...e.pts, ...f.pts.slice(1)];
        // Re-smooth a window round the joint only (the rest, bridges included, stays as shaped).
        const lo = Math.max(0, joint - JOIN_SMOOTH), hi = Math.min(pts.length - 1, joint + JOIN_SMOOTH);
        const mid = smoothPath(pts.slice(lo, hi + 1), blocked);
        mid[0] = pts[lo];
        mid[mid.length - 1] = pts[hi];
        e.pts = [...pts.slice(0, lo), ...mid, ...pts.slice(hi + 1)];
        e.to = f.to;
        const end = nodes[f.to];
        end.edges[end.edges.indexOf(f.id)] = e.id;
        n.edges = [];
        f.pts = [];
        changed = true;
      }
    }
    rasterize();

    /** Dirt edge `d` at town node `n` becomes asphalt up to a dry point just outside the town (split there). */
    function pave(n: GridNode, d: GridEdge): void {
      if (d.from !== n.id) reverseEdge(d);
      const last = d.pts.length - 1;
      const t = d.pts.findIndex((p, i) => i >= 3 && i <= last - 3 && !inTownAt(p, PAVE_MARGIN) && dryAround(ctx, p));
      if (t < 0) {
        // Never leaves town (or no dry point to change surface on): paved whole if it stays inside.
        if (d.pts.every((p) => inTownAt(p, PAVE_MARGIN))) d.type = 'asphalt';
        return;
      }
      splitEdge(d.id, t, 'junction'); // d keeps the head: n -> split point
      d.type = 'asphalt';
    }
  }

  /**
   * Every road leaves a 3- / 4-way junction straight: its first ARM_STRAIGHT cells become the chord from the node,
   * so the junction plate, crosswalks and stop lines (planned from the leaving direction) line up with the ribbon.
   */
  function straightenArms(): void {
    for (const n of nodes) {
      if (n.kind !== 'junction' || n.edges.length < 3) continue;
      for (const id of n.edges) {
        const e = edges[id];
        if (e.type === 'rail' || e.from === e.to) continue;
        const atStart = e.from === n.id;
        const pts = atStart ? e.pts : e.pts.slice().reverse();
        // Chord end: ARM_STRAIGHT along, at most a third of the edge (the far end may be straightened too).
        const reach = Math.min(ARM_STRAIGHT, polyLength(pts) / 3);
        let k = 1, run = 0;
        while (k < pts.length - 1 && run + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) < reach) {
          run += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          k++;
        }
        // Shorter where the full chord would cut over water (an arm heading for a bridge).
        let chord = straight(pts[0], pts[k]);
        while (k >= 2 && chord.some(([x, y]) => blocked(x, y))) chord = straight(pts[0], pts[--k]);
        if (k < 2) continue;
        const out = [...chord, ...pts.slice(k + 1)];
        e.pts = atStart ? out : out.reverse();
      }
    }
    rasterize();
  }

  /** Drops edges emptied by the clean-up passes, renumbering the rest. */
  function dropRemovedEdges(): void {
    const live = edges.filter((e) => e.pts.length);
    if (live.length === edges.length) return;
    const newId = new Map(live.map((e, i) => [e.id, i]));
    live.forEach((e, i) => (e.id = i));
    edges.length = 0;
    edges.push(...live);
    for (const n of nodes) n.edges = n.edges.map((id) => newId.get(id)!);
    rasterize();
  }

  function reverseEdge(e: GridEdge): void {
    [e.from, e.to] = [e.to, e.from];
    e.pts.reverse();
  }

  /** Step 6: the railway between the two planned end points, with bridges and level crossings. */
  function buildRail({ from, to }: RailPlan): void {
    rasterize();
    const mark = (cx: number, cy: number, r: number, out: Uint8Array) => {
      for (let y = Math.max(0, Math.round(cy - r)); y <= Math.min(N - 1, Math.round(cy + r)); y++)
        for (let x = Math.max(0, Math.round(cx - r)); x <= Math.min(N - 1, Math.round(cx + r)); x++) out[y * N + x] = 1;
    };
    const nearNode = new Uint8Array(N * N);
    for (const n of nodes) if (n.edges.length) mark(n.x, n.y, RAIL_NODE_CLEARANCE, nearNode);
    const nearBase = new Uint8Array(N * N);
    for (const b of bases) mark(b.x, b.y, b.half + RAIL_BASE_MARGIN, nearBase);
    for (const c of cities) mark(c.x, c.y, c.radius, nearBase); // through the outskirts at most
    const nearRoad = distanceField(N, (k) => owner[k] >= 0, 5);
    const shore = distanceField(N, isWater, 2);
    const { heights, corridor, cell } = ctx;

    const railCost = (a: number, b: number, diagonal: boolean): number => {
      const len = diagonal ? Math.SQRT2 : 1;
      if (nearBase[b]) return Infinity;
      if (isWater(b)) {
        if (!ctx.nearRiver[b]) return Infinity; // sea (river banks below the waterline are fine)
        if (corridor[b] && usedCrossings.has(corridor[b] - 1)) return Infinity; // a road bridge is there
        return len * BRIDGE_COST * (corridor[b] ? 1 : 3); // planned crossing sites are the best spots
      }
      if (isWater(a)) return len * 2; // abutment
      if (owner[b] >= 0) {
        // Level crossing: on dry road, away from junctions / bases / exits and from bridges.
        const road = edges[owner[b]].pts, t = ownerIdx[b];
        if (nearNode[b] || !dryAround(ctx, road[t])) return Infinity;
        // Roughly square to the road (8 step directions: at least ~40 degrees off it).
        const p = road[Math.max(0, t - 2)], q = road[Math.min(road.length - 1, t + 2)];
        const rx = q[0] - p[0], ry = q[1] - p[1];
        const sx = (b % N) - (a % N), sy = Math.floor(b / N) - Math.floor(a / N);
        if (Math.abs(rx * sx + ry * sy) > RAIL_CROSS_COS * Math.hypot(rx, ry) * len) return Infinity;
        return len * RAIL_ROAD_COST;
      }
      const grade = Math.abs(heights[b] - heights[a]) / (len * cell);
      if (grade > RAIL_MAX_GRADE) return Infinity;
      const beside = (nearRoad[b] <= 5 ? 2 * (6 - nearRoad[b]) : 0) + (shore[b] <= 2 ? 4 : 0); // not alongside roads or shores
      return len * (1 + grade * grade * 300 + beside + Math.max(0, heights[b] - 8) * 0.05);
    };
    // Tunnel ends: routed between the approach points, then run straight into the portals.
    const a = routeStart(from), b = routeStart(to);
    const goal = b.y * N + b.x;
    const path = findPath({
      N,
      start: a.y * N + a.x,
      cost: railCost,
      isGoal: (c) => c === goal,
      heuristic: (c) => {
        const dx = Math.abs((c % N) - b.x), dy = Math.abs(Math.floor(c / N) - b.y);
        return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
      },
    });
    if (!path) return;
    // Smoothing may move the line over any river (it is bridged wherever it crosses one),
    // but never onto the sea or a road's bridge.
    const roadBridge = new Set(usedCrossings);
    const railBlocked = (x: number, y: number): boolean => {
      const k = cellAt(x, y);
      return k >= 0 && isWater(k) && (!ctx.nearRiver[k] || (corridor[k] > 0 && roadBridge.has(corridor[k] - 1)));
    };
    markUsed(path);

    const line = [...approachPoints(from), ...toPoints(path, N), ...approachPoints(to).reverse()];
    let rest = smoothPath(line, railBlocked, RAIL_MIN_RADIUS);
    let start = addNode(from.x, from.y, 'exit');
    const end = addNode(to.x, to.y, 'exit');
    // Walk along the line; at every road it crosses, split both at the exact crossing point.
    for (let hit = firstRoadCrossing(rest); hit; hit = firstRoadCrossing(rest)) {
      const e = edges[hit.edge];
      e.pts.splice(hit.roadSeg + 1, 0, hit.point);
      const node = splitEdge(hit.edge, hit.roadSeg + 1, 'crossing');
      pushEdge(start, node, 'rail', [...rest.slice(0, hit.railSeg + 1), hit.point]);
      rest = [hit.point, ...rest.slice(hit.railSeg + 1)];
      start = node;
    }
    pushEdge(start, end, 'rail', rest);
  }

  /** First point (from the start of `line`) where it crosses a road edge, skipping a touch at its very start. */
  function firstRoadCrossing(line: Point[]): { edge: number; roadSeg: number; railSeg: number; point: Point } | null {
    const roads = edges.filter((e) => e.type !== 'rail').map((e) => ({ e, box: bounds(e.pts) }));
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      let best: { edge: number; roadSeg: number; railSeg: number; point: Point; t: number } | null = null;
      for (const { e, box } of roads) {
        if (Math.max(a[0], b[0]) < box[0] || Math.min(a[0], b[0]) > box[2] || Math.max(a[1], b[1]) < box[1] || Math.min(a[1], b[1]) > box[3]) continue;
        for (let j = 0; j < e.pts.length - 1; j++) {
          const t = segmentHit(a, b, e.pts[j], e.pts[j + 1]);
          if (t === null || (i === 0 && t < 0.05) || (best && t >= best.t)) continue;
          best = { edge: e.id, roadSeg: j, railSeg: i, t, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
        }
      }
      if (best) return best;
    }
    return null;
  }
}

/** Parameter along a-b where it crosses segment c-d (inside both, end of c-d included once), else null. */
function segmentHit(a: Point, b: Point, c: Point, d: Point): number | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t < 1 && u >= 0 && u < 1 ? t : null;
}

/** [minX, minY, maxX, maxY] of a polyline. */
function bounds(pts: Point[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/**
 * Step cost for road routing. With `anyRiver`, rivers may be bridged anywhere
 * (last-resort reconnection of road pieces cut off by rivers); otherwise only
 * inside planned crossing corridors.
 */
function makeCost({ N, cell, heights, corridor, riverMask }: RoadContext, noise: Noise2D, anyRiver = false) {
  const W = WATER_LEVEL;
  // Gentle cost variation so roads wander a little instead of running dead straight.
  const wobble = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) wobble[j * N + i] = (noise(i * 0.05, j * 0.05) * 0.5 + 0.5) * 0.6;

  // River beds count as water even where smoothing lifted a narrow stream above the waterline.
  const wet = (k: number) => heights[k] < W + 0.25 || riverMask[k] > 0;
  // Keep roads off the water's edge (curve smoothing would pull them into it).
  // Crossing corridors are exempt: they are the straight approaches onto bridges.
  const shore = distanceField(N, wet, 3);
  return (a: number, b: number, diagonal: boolean): number => {
    const len = diagonal ? Math.SQRT2 : 1;
    // Water only at planned river crossings; never into the sea or along a river.
    if (wet(b)) {
      if (corridor[b]) return len * BRIDGE_COST;
      return anyRiver && riverMask[b] ? len * BRIDGE_COST * 6 : Infinity;
    }
    if (wet(a)) return len * 2; // bridge abutment
    const atCrossing = corridor[b] > 0 || anyRiver;
    if (shore[b] <= 1 && !atCrossing) return Infinity;
    const ha = heights[a], hb = heights[b];
    const grade = Math.abs(hb - ha) / (len * cell);
    if (grade > MAX_GRADE) return Infinity;
    const shoreCost = shore[b] <= 3 && !atCrossing ? 3 : 0;
    return len * (1 + grade * grade * 80 + Math.max(0, hb - 8) * 0.05 + wobble[b] + shoreCost);
  };
}

/** Chebyshev distance (in cells, capped at `max` + 1) from each cell to the nearest cell matching `is`. */
function distanceField(N: number, is: (k: number) => boolean, max: number): Uint8Array {
  const d = new Uint8Array(N * N).fill(max + 1);
  let frontier: number[] = [];
  for (let k = 0; k < N * N; k++) if (is(k)) { d[k] = 0; frontier.push(k); }
  for (let step = 1; step <= max && frontier.length; step++) {
    const next: number[] = [];
    for (const k of frontier) {
      const x = k % N, y = (k - x) / N;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const n = ny * N + nx;
          if (d[n] > step) {
            d[n] = step;
            next.push(n);
          }
        }
    }
    frontier = next;
  }
  return d;
}

/** No water within 3 cells: junctions must sit on dry ground, never on a bridge. */
function dryAround({ N, heights, riverMask }: RoadContext, [px, py]: Point): boolean {
  const x = Math.round(px), y = Math.round(py);
  for (let j = Math.max(0, y - 3); j <= Math.min(N - 1, y + 3); j++)
    for (let i = Math.max(0, x - 3); i <= Math.min(N - 1, x + 3); i++)
      if (heights[j * N + i] < WATER_LEVEL + 0.25 || riverMask[j * N + i]) return false;
  return true;
}

/** Points ~1 cell apart on the straight line from a to b (both ends included). */
function straight(a: Point, b: Point): Point[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
  return Array.from({ length: n + 1 }, (_, i): Point => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
}

/** Unit vector from b to a. */
function unit(a: Point, b: Point): Point {
  const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Where the lines through a (direction da) and b (direction db) cross; null if (nearly) parallel. */
function lineHit(a: Point, da: Point, b: Point, db: Point): Point | null {
  const den = da[0] * db[1] - da[1] * db[0];
  if (Math.abs(den) < 0.2) return null;
  const s = ((b[0] - a[0]) * db[1] - (b[1] - a[1]) * db[0]) / den;
  return [a[0] + da[0] * s, a[1] + da[1] * s];
}

/** `pts` without its trailing points beyond `X` along `dir` (at least two points kept). */
function trimPast(pts: Point[], X: Point, dir: Point): Point[] {
  let n = pts.length;
  while (n > 2 && (pts[n - 1][0] - X[0]) * dir[0] + (pts[n - 1][1] - X[1]) * dir[1] > -0.5) n--;
  return pts.slice(0, n);
}

function polyLength(pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

/** `pts` with its ends exactly on nodes a and b. */
function endsAt(pts: Point[], a: GridPoint, b: GridPoint): Point[] {
  pts[0] = [a.x, a.y];
  pts[pts.length - 1] = [b.x, b.y];
  return pts;
}

function toPoints(path: number[], N: number): Point[] {
  return path.map((c) => [c % N, Math.floor(c / N)]);
}

function distToNetwork(s: GridPoint, edges: GridEdge[]): number {
  let best = Infinity;
  for (const e of edges)
    for (const [x, y] of e.pts) best = Math.min(best, Math.hypot(x - s.x, y - s.y));
  return best;
}
