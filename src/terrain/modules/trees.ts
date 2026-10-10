// Trees module: forests in clumps plus scattered single trees. One species per map.
// Trees keep off mountains, water, roads, rocks, cliffs and the player base areas,
// and are sparse on dirt, so the battlefield keeps open lanes between woods.

import type { Rng } from '../../core/rng.ts';
import { fbm, smoothstep, type Noise2D } from '../../core/noise.ts';
import { sampleGrid, slopeField } from '../grid.ts';
import { WATER_LEVEL } from '../types.ts';
import type { Rock } from './rocks.ts';

export type TreeType = 'pine' | 'broadleaf';
export const TREE_TYPES: readonly TreeType[] = ['pine', 'broadleaf'];

export interface Tree {
  /** World position; y is the ground height. */
  x: number;
  y: number;
  z: number;
  /** Size multiplier (1 = typical tree). */
  scale: number;
  /** Rotation about the vertical axis, radians. */
  yaw: number;
}

export interface TreeCover {
  type: TreeType;
  trees: Tree[];
}

export interface TreeInput {
  N: number;
  cell: number;
  /** Grid cells per unit of forest noise (the play area side), so clump size doesn't depend on the grid size. */
  span: number;
  heights: Float32Array;
  /** Height mountains add per cell (0 on open ground). */
  mountain: Float32Array;
  riverMask: Uint8Array;
  roadMask: Uint8Array;
  /** Dirt amount per cell (0..1). */
  dirt: Float32Array;
  /** Cells kept clear of trees (base build areas). */
  clear: Uint8Array;
  rocks: Rock[];
}

/** Highest ground each species grows on (pines tolerate a little more height). */
const TREE_LINE: Record<TreeType, number> = { pine: 22, broadleaf: 20 };
/** No trees where mountains add more than this height (m): forests stay on open ground. */
const MOUNTAIN_LIMIT = 2;
/** Steeper than this (1 - normal.y): no trees. */
const MAX_SLOPE = 0.45;

export function plantTrees(input: TreeInput, rng: Rng, noise: Noise2D): TreeCover {
  const planter = treePlanter(input, rng, noise);
  return { type: planter.type, trees: planter.rows(0, input.N) };
}

export interface TreePlanter {
  type: TreeType;
  /** Plants rows j0..j1-1 and returns their trees. Rows must go in order (top to bottom): the random stream runs row by row. */
  rows(j0: number, j1: number): Tree[];
}

/** Picks the species and prepares the map-wide masks; planting then runs in row bands. */
export function treePlanter(input: TreeInput, rng: Rng, noise: Noise2D): TreePlanter {
  const { N, cell, span, heights, mountain, riverMask, roadMask, clear, dirt, rocks } = input;
  const type = TREE_TYPES[Math.floor(rng() * TREE_TYPES.length)];
  const slope = slopeField(heights, N, cell);
  const half = ((N - 1) * cell) / 2;

  // Cells trees may not use: rocks, road shoulders, base build areas.
  const blocked = new Uint8Array(N * N);
  const block = (gx: number, gy: number, r: number) => {
    for (let j = Math.max(0, Math.floor(gy - r)); j <= Math.min(N - 1, Math.ceil(gy + r)); j++)
      for (let i = Math.max(0, Math.floor(gx - r)); i <= Math.min(N - 1, Math.ceil(gx + r)); i++)
        if (Math.hypot(i - gx, j - gy) <= r) blocked[j * N + i] = 1;
  };
  for (let k = 0; k < roadMask.length; k++) {
    if (!roadMask[k]) continue;
    block(k % N, Math.floor(k / N), 1.5);
  }
  for (const r of rocks) block((r.x + half) / cell, (r.z + half) / cell, r.size / cell + 0.5);
  for (let k = 0; k < clear.length; k++) if (clear[k]) blocked[k] = 1;

  const rows = (j0: number, j1: number): Tree[] => {
    const trees: Tree[] = [];
    for (let j = Math.max(1, j0); j < Math.min(N - 1, j1); j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        const h = heights[k];
        if (h < WATER_LEVEL + 1.2 || riverMask[k] || blocked[k] || slope[k] > MAX_SLOPE) continue;
        if (mountain[k] > MOUNTAIN_LIMIT) continue;
        const u = i / span, v = j / span;

        // Forest clumps with ragged edges; a few lone trees in between.
        const forest = smoothstep(0.5, 0.68, fbm(noise, u * 5, v * 5, 4) * 0.5 + 0.5);
        // Thin out towards the tree line and on dirt.
        const altitude = 1 - smoothstep(TREE_LINE[type] - 6, TREE_LINE[type], h);
        const p = (forest * 0.42 + 0.008) * altitude * (1 - dirt[k] * 0.85);
        if (rng() >= p) continue;

        const gx = i + (rng() - 0.5) * 0.8;
        const gy = j + (rng() - 0.5) * 0.8;
        trees.push({
          x: gx * cell - half,
          y: sampleGrid(heights, N, gx, gy),
          z: gy * cell - half,
          // Forest interiors grow taller than lone trees.
          scale: (0.75 + rng() * 0.45) * (0.85 + forest * 0.2),
          yaw: rng() * Math.PI * 2,
        });
      }
    }
    return trees;
  };
  return { type, rows };
}
