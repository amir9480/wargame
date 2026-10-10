// Map exits: 0..2 roads that come in from the outer edge of the grid, through the play area border. Where a mountain
// range walls off the edge, the road (or railway) instead ends at a tunnel portal at the range's foot.

import { shuffle, type Rng } from '../../../core/rng.ts';
import { outerEdgePoint } from '../../grid.ts';
import { SIDES, WATER_LEVEL, type GridPoint, type Point, type Side } from '../../types.ts';
import type { RoadContext } from './context.ts';

export const MAX_EXITS = 2;

/** Mountain height (m, relief `mountain` field) at a tunnel portal: the range rises steeply just behind it. */
export const TUNNEL_MOUNTAIN = 10;

/**
 * Tunnel portal size (m), shared by the road carving (earth mound over the barrel) and the portal model: ground behind
 * the headwall is raised to TUNNEL_COVER above the road, over the headwall's width (road + TUNNEL_SPAN_EXTRA) and the
 * barrel's length.
 */
export const TUNNEL_COVER = 7;
export const TUNNEL_SPAN_EXTRA = 6.8;
export const TUNNEL_BARREL = 16;

/** Straight run (cells) into a tunnel portal: the road / railway arrives heading into the mountain. */
const TUNNEL_APPROACH = 8;

/** Map exit or rail end; `tunnel` = it is a portal into the mountain range on that edge, not the grid edge. */
export interface ExitSite extends GridPoint {
  tunnel: boolean;
  /** Tunnel only: routing starts here, TUNNEL_APPROACH cells straight out from the portal (see `approachPoints`). */
  approach?: GridPoint;
}

/** Routing start of a site: its approach point for a tunnel, else the site itself. */
export function routeStart(site: ExitSite): GridPoint {
  return site.approach ?? site;
}

/** Points from the site to its routing start (the straight tunnel approach), to put before a path routed from there. */
export function approachPoints(site: ExitSite): Point[] {
  if (!site.approach) return [];
  const { x, y } = site, { x: ax, y: ay } = site.approach;
  return Array.from({ length: TUNNEL_APPROACH }, (_, s): Point => [x + ((ax - x) * s) / TUNNEL_APPROACH, y + ((ay - y) * s) / TUNNEL_APPROACH]);
}

/**
 * Where a way out through `side` at `along` starts: the outer grid edge, or, when a mountain range stands on that edge
 * (its ridge; the range falls away again towards the grid edge), the first cell inward past the ridge where the range
 * has dropped to TUNNEL_MOUNTAIN.
 */
export function exitSite({ N, play, mountain }: RoadContext, side: Side, along: number): ExitSite {
  const at = (inset: number) => {
    const q = outerEdgePoint(side, along, N, play, inset);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  };
  const m = (inset: number) => {
    const c = at(inset);
    return mountain[c.y * N + c.x];
  };
  // Ridge: the range's highest point on the line in from the edge (ranges stand in the outer quarter of the grid).
  let ridge = 0;
  for (let inset = 1; inset < N / 4; inset++) if (m(inset) > m(ridge)) ridge = inset;
  if (m(ridge) <= TUNNEL_MOUNTAIN) return { ...at(0), tunnel: false };
  for (let inset = ridge + 1; inset < N / 2; inset++) {
    if (m(inset) <= TUNNEL_MOUNTAIN) return { ...at(inset), tunnel: true, approach: at(inset + TUNNEL_APPROACH) };
  }
  return { ...at(0), tunnel: false };
}

/**
 * 0..MAX_EXITS exits on distinct land edges. Each takes the lowest, gentlest spot
 * along its edge, so roads come in through passes or end at a tunnel at a range's foot.
 */
export function pickExits(ctx: RoadContext, rng: Rng): ExitSite[] {
  const { N, heights, slope, nearRiver, seaSides } = ctx;
  const landSides = shuffle(SIDES.filter((s) => !seaSides.includes(s)), rng);
  const want = Math.min(landSides.length, Math.floor(rng() * (MAX_EXITS + 1)));
  const exits: ExitSite[] = [];
  for (const side of landSides.slice(0, want)) {
    let best: ExitSite | null = null;
    let bestScore = Infinity;
    const samples = 48;
    for (let s = 0; s < samples; s++) {
      const along = 0.12 + ((s + rng()) / samples) * 0.76;
      const p = exitSite(ctx, side, along);
      const k = p.y * N + p.x;
      if (heights[k] < WATER_LEVEL + 1 || nearRiver[k]) continue;
      const score = heights[k] + slope[k] * 40 + rng() * 3;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) exits.push(best);
  }
  return exits;
}
