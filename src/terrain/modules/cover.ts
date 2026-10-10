// Ground cover module: where the ground is bare dirt instead of grass.
// Dirt forms large irregular patches, favours dry, higher and moderately sloped
// ground and the shoulders of roads, and gives way to grass near rivers.

import { fbm, smoothstep, type Noise2D } from '../../core/noise.ts';
import { boxBlur, slopeField } from '../grid.ts';
import { WATER_LEVEL } from '../types.ts';

export interface CoverInput {
  N: number;
  cell: number;
  /** Grid cells per unit of cover noise (the play area side), so patch size doesn't depend on the grid size. */
  span: number;
  heights: Float32Array;
  /** Non-zero on river beds. */
  riverMask: Uint8Array;
  /** 1 on road cells. */
  roadMask: Uint8Array;
  /** 1 under buildings and their yards (worn like road shoulders). */
  builtMask?: Uint8Array;
}

/** Patch threshold on the cover noise (higher = less dirt); tuned for ~25-30% dirt on land. */
const DIRT_EDGE = 0.6;

/** Dirt amount per grid cell, 0 (grass) .. 1 (bare dirt). */
export function generateCover(input: CoverInput, noise: Noise2D): Float32Array {
  const cover = coverBuilder(input, noise);
  cover.rows(0, input.N);
  return cover.dirt;
}

export interface CoverBuilder {
  /** Dirt per cell; rows are filled by `rows`. */
  dirt: Float32Array;
  /** Fills rows j0..j1-1 (cells are independent, any order). */
  rows(j0: number, j1: number): void;
}

/** Computes the map-wide fields (slope, moisture, road wear) up front; the per-cell pass then runs in row bands. */
export function coverBuilder({ N, cell, span, heights, riverMask, roadMask, builtMask }: CoverInput, noise: Noise2D): CoverBuilder {
  const slope = slopeField(heights, N, cell);
  // Distance-ish fields: ~8 cells around rivers (moist), ~3 cells around roads (worn).
  const wet = boxBlur(boxBlur(Float32Array.from(riverMask, (v) => (v ? 1 : 0)), N, 4), N, 4);
  const worn = boxBlur(Float32Array.from(roadMask, (v, k) => (builtMask?.[k] ? 1 : v)), N, 3);

  const dirt = new Float32Array(N * N);
  const rows = (j0: number, j1: number) => {
    for (let j = j0; j < j1; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = heights[k];
        if (h < WATER_LEVEL) continue;
        const u = i / span, v = j / span;
        // Large patches with ragged edges.
        let n = fbm(noise, u * 3.2, v * 3.2, 5, 2, 0.55) * 0.5 + 0.5;
        // Drier on higher ground and moderate slopes; grassier near water.
        n += smoothstep(4, 14, h) * 0.12 + smoothstep(0.08, 0.3, slope[k]) * 0.1 - wet[k] * 0.45;
        let d = smoothstep(DIRT_EDGE, DIRT_EDGE + 0.08, n);
        // Worn shoulders along roads.
        d = Math.max(d, smoothstep(0.15, 0.6, worn[k]) * 0.7);
        dirt[k] = d;
      }
    }
  };
  return { dirt, rows };
}
