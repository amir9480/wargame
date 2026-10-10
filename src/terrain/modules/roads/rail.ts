// Railway: on maps with at least two land (non-sea) edges, a single line runs
// from one land edge of the grid to another (opposite edges preferred), with
// bridges over rivers and level crossings where it meets roads.
// The route itself is grown by the network (see growNetwork step 5), after the
// roads, so it can cross them only where a level crossing fits.

import type { Rng } from '../../../core/rng.ts';
import { exitSite, type ExitSite } from './sites.ts';
import { SIDES, WATER_LEVEL, type Side } from '../../types.ts';
import type { RoadContext } from './context.ts';

/** Chance a map with two or more land edges gets a railway. */
export const RAIL_CHANCE = 0.5;
/** Chance to run between opposite land edges when there is such a pair (else adjacent edges). */
const OPPOSITE_CHANCE = 0.75;
/** Steepest ground the railway may climb while routing; the track profile is then flattened (cuttings / embankments). */
export const RAIL_MAX_GRADE = 0.45;
/** Tightest bend, in grid cells. */
export const RAIL_MIN_RADIUS = 10;
/** Cost of each road cell crossed: few, short (square-on) level crossings. */
export const RAIL_ROAD_COST = 25;
/** Cosine limit between the railway's step onto a road and the road's direction (level crossings near square). */
export const RAIL_CROSS_COS = 0.5;
/** Level crossings stay this many cells away from any road node (junction, base, exit). */
export const RAIL_NODE_CLEARANCE = 5;
/** Cells around a base's build area the railway keeps out of. */
export const RAIL_BASE_MARGIN = 6;

export interface RailPlan {
  from: ExitSite;
  to: ExitSite;
}

/** Railway end points on the grid's outer edge (or tunnel portals at a range's foot), or null for no railway on this map. */
export function pickRail(ctx: RoadContext, rng: Rng): RailPlan | null {
  // Every random value is drawn whatever the outcome, so the stream stays aligned.
  const roll = rng(), pairRoll = rng(), pick = rng();
  const land = SIDES.filter((s) => !ctx.seaSides.includes(s));
  if (land.length < 2 || roll >= RAIL_CHANCE) return null;

  const pairs: [Side, Side][] = [];
  for (let a = 0; a < land.length; a++) for (let b = a + 1; b < land.length; b++) pairs.push([land[a], land[b]]);
  const opposite = (p: [Side, Side]) => (SIDES.indexOf(p[0]) + 2) % 4 === SIDES.indexOf(p[1]);
  const opp = pairs.filter(opposite), adj = pairs.filter((p) => !opposite(p));
  const pool = opp.length && (pairRoll < OPPOSITE_CHANCE || !adj.length) ? opp : adj;
  const [sa, sb] = pool[Math.floor(pick * pool.length)];
  const from = railEnd(ctx, sa, rng), to = railEnd(ctx, sb, rng);
  return from && to ? { from, to } : null;
}

/** Lowest, gentlest dry spot along an outer edge (the line comes in through a pass, or out of a tunnel). */
function railEnd(ctx: RoadContext, side: Side, rng: Rng): ExitSite | null {
  const { N, heights, slope, nearRiver } = ctx;
  let best: ExitSite | null = null;
  let bestScore = Infinity;
  const samples = 40;
  for (let s = 0; s < samples; s++) {
    const along = 0.2 + ((s + rng()) / samples) * 0.6;
    const p = exitSite(ctx, side, along);
    const k = p.y * N + p.x;
    if (heights[k] < WATER_LEVEL + 1 || nearRiver[k]) continue;
    const score = heights[k] + slope[k] * 40 + rng() * 3;
    if (score < bestScore) [best, bestScore] = [p, score];
  }
  return best;
}
