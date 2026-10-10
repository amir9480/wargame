// Edge ranges module: most land (non-sea) edges are walled off by a mountain range.

import type { Rng } from '../../core/rng.ts';
import { fbm, smoothstep, lerp, type Noise2D } from '../../core/noise.ts';
import { edgeCoords } from '../grid.ts';
import { floodShape } from '../mountains/library.ts';
import { SIDES, type Side } from '../types.ts';
import type { SeaSide } from './sea.ts';

/** Chance that a non-sea edge is walled off by a mountain range. */
export const EDGE_RANGE_CHANCE = 0.8;

/**
 * Height factor of the main ridge: the foothills inside the play area stay at gameplay scale, the range climbs
 * outward into the margin to real mountain height (a few hundred metres), as a backdrop.
 */
const OUTER_RISE = 2.2;
/**
 * Distance outward from the play area border (play-area units) of the main ridge. It stands before the map-edge
 * haze takes hold (fogdist.glsl, from a quarter of the margin), so the summits stay clear; beyond it the range
 * falls away to OUTER_FALL of its height at the grid edge, low enough for the haze to hide the grid's end (the haze
 * spares high ground, fogdist.glsl).
 */
const RIDGE_REACH = 0.09;
const OUTER_FALL = 0.1;
/** Grid edge, play-area units outward from the border (pad 64 cells / 255). */
const GRID_EDGE = 0.25;

/** Mountain range running along a land edge of the map. */
export interface EdgeRange {
  side: Side;
  index: number;
  /** Peak height in world units at the play area border; the range rises to `OUTER_RISE` times that at the grid edge. */
  height: number;
  /** How far the range reaches into the map, as a fraction of map size. */
  depth: number;
}

export function pickEdgeRanges(seaSides: SeaSide[], rng: Rng): EdgeRange[] {
  const ranges: EdgeRange[] = [];
  for (const side of SIDES) {
    // Draw every value for every side so results don't depend on which sides are sea.
    const roll = rng();
    const height = 40 + rng() * 25;
    const depth = 0.08 + rng() * 0.08;
    if (seaSides.some((s) => s.side === side) || roll >= EDGE_RANGE_CHANCE) continue;
    ranges.push({ side, index: SIDES.indexOf(side), height, depth });
  }
  return ranges;
}

/**
 * Height of the edge mountain ranges at (u, v); 0 outside them. `shape(range)` = real mountain height 0..1 at
 * this point for that range (see mountains/library.ts); the range profile and saddles flood it from below.
 */
export function edgeRangeHeight(u: number, v: number, ranges: EdgeRange[], detail: Noise2D, shape: (r: EdgeRange) => number): number {
  let h = 0;
  for (const r of ranges) {
    const [d, along] = edgeCoords(r.side, u, v);
    if (d > r.depth * 1.6) continue;
    const o = r.index * 37.1;
    // Ragged inner boundary so the range doesn't read as a straight wall.
    const reach = d + fbm(detail, along * 4 + o, o, 3) * r.depth * 0.45;
    const profile = 1 - smoothstep(r.depth * 0.3, r.depth, reach);
    if (profile <= 0) continue;
    // Occasional lower saddles (shallow: a deep notch between tall ridges reads as a slot canyon; ways out are tunnels).
    const saddle = smoothstep(0.3, 0.5, fbm(detail, along * 2.2 + o + 500, o, 2) * 0.5 + 0.5);
    // Valley floors kept a quarter up, so the range still walls off the edge.
    const peaks = floodShape(0.25 + 0.75 * shape(r), profile * lerp(0.65, 1, saddle));
    // Climbs from where the range is at full profile to the main ridge outside the border, then falls away to the grid edge.
    const rise = lerp(1, OUTER_RISE, smoothstep(r.depth * 0.3, -RIDGE_REACH, reach)) * lerp(1, OUTER_FALL, smoothstep(-RIDGE_REACH, -GRID_EDGE, reach));
    h = Math.max(h, r.height * rise * peaks);
  }
  return h;
}
