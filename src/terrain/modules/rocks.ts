// Rocks module: scatters boulders and debris over the finished heightmap.
// Rocks gather where they would naturally fall: at the foot of mountains and
// steep slopes (scree, fallen boulders), thinner on the mountains themselves,
// and only a rare stray boulder on open ground so battlefields stay clear. None up in the snow.

import type { Rng } from '../../core/rng.ts';
import { smoothstep, type Noise2D } from '../../core/noise.ts';
import { boxBlur, sampleGrid, slopeField } from '../grid.ts';
import { SNOW_LINE, SNOW_MARGIN, WATER_LEVEL } from '../types.ts';

/** Number of distinct rock shapes; `Rock.variant` is in 0..ROCK_VARIANTS-1. */
export const ROCK_VARIANTS = 4;

export interface Rock {
  /** World position (map centred on the origin); y is the ground height at (x, z). */
  x: number;
  y: number;
  z: number;
  /** Approximate radius in world units. */
  size: number;
  /** Rotation about the vertical axis, radians. */
  yaw: number;
  variant: number;
}

export interface RockOptions {
  /** Overall density multiplier. */
  density?: number;
  /** Cells to keep clear (1 = blocked), e.g. roads. */
  blocked?: Uint8Array;
  /** River cells (non-zero = river): rivers get extra rocks in the bed and on the banks. */
  riverMask?: Uint8Array;
  /** Vertical scale of the mountains (Terrain.heightScale): the snow line, and so the rock-free height, scales with it. */
  heightScale?: number;
}

/** Ground below this is water, river bed or wet shore: no rocks. */
const MIN_GROUND = WATER_LEVEL + 0.6;
/** River bed / bank cells accept rocks down to this height: boulders sit in the bed and poke out of the water. */
const MIN_RIVER_GROUND = WATER_LEVEL - 2;
/** A rock's top rises about this fraction of its size above the ground it stands on (shape height less the sink). */
const RIVER_ROCK_RISE = 0.8;
/** Largest rock (size) allowed in the water; deeper spots stay empty. */
const MAX_RIVER_ROCK = 3;
/** Steeper than this (1 - normal.y) is a cliff face nothing can rest on. */
const MAX_SLOPE = 0.6;

export function scatterRocks(
  heights: Float32Array, N: number, cell: number, rng: Rng, noise: Noise2D, options: RockOptions = {},
): Rock[] {
  return rockScatter(heights, N, cell, rng, noise, options)(0, N);
}

/**
 * Prepares the map-wide fields, then returns a scanner that scatters rocks over rows j0..j1-1 and returns the new ones.
 * Rows must be scanned in order (top to bottom): the random stream runs row by row.
 */
export function rockScatter(
  heights: Float32Array, N: number, cell: number, rng: Rng, noise: Noise2D, { density = 1, blocked, riverMask, heightScale = 1 }: RockOptions = {},
): (j0: number, j1: number) => Rock[] {
  const slope = slopeField(heights, N, cell);

  // River influence: 1 in the channel, fading over ~5 cells onto the banks.
  const river = riverMask
    ? boxBlur(boxBlur(Float32Array.from(riverMask, (v) => (v ? 1 : 0)), N, 2), N, 2)
    : new Float32Array(N * N);
  const minGround = (k: number) => (river[k] > 0.15 ? MIN_RIVER_GROUND : MIN_GROUND);

  // How mountainous each cell is: steep or high ground.
  const mountain = new Float32Array(N * N);
  for (let k = 0; k < mountain.length; k++) {
    mountain[k] = Math.max(smoothstep(0.22, 0.45, slope[k]), smoothstep(10, 20, heights[k]));
  }
  // Spread outward (two box passes ~ tent filter, ~12 cells) so the ground
  // beside mountains scores too: that is where fallen rock ends up.
  const near = boxBlur(boxBlur(mountain, N, 6), N, 6);

  const half = ((N - 1) * cell) / 2;
  let rocks: Rock[] = [];

  const place = (gx: number, gy: number, size: number): boolean => {
    if (gx < 1 || gy < 1 || gx > N - 2 || gy > N - 2) return false;
    const y = sampleGrid(heights, N, gx, gy);
    const k = Math.round(gy) * N + Math.round(gx);
    if (y < minGround(k)) return false;
    if (y < MIN_GROUND) {
      // Standing in the water: grow the rock until its top clears the surface, so it sits half submerged.
      size = Math.max(size, (WATER_LEVEL - y + 0.25 + rng() * 0.5) / RIVER_ROCK_RISE);
      if (size > MAX_RIVER_ROCK) return false;
    }
    // No rocks on or under snow: the whole boulder (ground + its size) stays below where snow can start.
    if (y + size > (SNOW_LINE - SNOW_MARGIN) * heightScale) return false;
    if (slope[k] > MAX_SLOPE || blocked?.[k]) return false;
    rocks.push({
      x: gx * cell - half,
      y,
      z: gy * cell - half,
      size,
      yaw: rng() * Math.PI * 2,
      variant: Math.floor(rng() * ROCK_VARIANTS),
    });
    return true;
  };

  return (j0, j1) => {
    rocks = [];
    for (let j = Math.max(1, j0); j < Math.min(N - 1, j1); j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (heights[k] < minGround(k) || slope[k] > MAX_SLOPE || blocked?.[k]) continue;

        // Low-frequency clumping so rocks form fields with gaps, not an even sprinkle.
        const clump = smoothstep(0.3, 0.75, noise(i * 0.08, j * 0.08) * 0.5 + 0.5);
        const foothill = near[k] * (1 - mountain[k] * 0.8);
        const p =
          (0.26 * foothill * (0.2 + 0.8 * clump) + // beside mountains: most rocks
            0.025 * mountain[k] * clump + //           on the mountains: some
            0.15 * river[k] * (0.3 + 0.7 * clump) + // along rivers: boulders in the bed and on the banks
            0.0012) * //                               open ground: rare stray boulder
          density;
        if (rng() >= p) continue;

        const gx = i + rng() - 0.5;
        const gy = j + rng() - 0.5;
        // Big boulders are commoner right at the foot of the slopes.
        const big = rng() < 0.06 + 0.2 * foothill;
        const size = big ? 1.8 + rng() * 2.4 : 0.45 + rng() * rng() * 1.3;
        if (!place(gx, gy, size) || !big) continue;

        // Big boulders shed a few smaller fragments around them.
        const fragments = Math.floor(rng() * 4);
        for (let f = 0; f < fragments; f++) {
          const a = rng() * Math.PI * 2;
          const dist = (size * (1.1 + rng() * 1.4)) / cell;
          place(gx + Math.cos(a) * dist, gy + Math.sin(a) * dist, size * (0.18 + rng() * 0.3));
        }
      }
    }
    return rocks;
  };
}
