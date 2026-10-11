// Relief module: the base heightmap. Mixes rolling ground, inland mountain zones,
// edge ranges and the sea mask into a single height per grid point.
// Coordinates (u, v) are relative to the play area (0..1 across it, beyond that
// outside it), so coasts and edge ranges sit at the play area's edges and carry
// on outward to the end of the grid.

import { fbm, smoothstep, lerp, type Noise2D } from '../../core/noise.ts';
import { seaMask, type SeaSide } from './sea.ts';
import { edgeRangeHeight, type EdgeRange } from './ranges.ts';
import { floodShape, samplePatch, type PatchView } from '../mountains/library.ts';
import type { PlayArea } from '../types.ts';
import { linearScale } from '../scale.ts';

/** Peak height (m) of inland mountains. */
const INLAND_HEIGHT = 55;

export interface ReliefInput {
  seaSides: SeaSide[];
  ranges: EdgeRange[];
  noise: Noise2D;
  detail: Noise2D;
  /** Real mountain shapes: inland peaks, then one per edge range (by `EdgeRange.index`). */
  mountains: MountainViews;
  /** Play area span in cells (u, v = 1). */
  span: number;
}

export interface MountainViews {
  inland: PatchView;
  ranges: PatchView[];
}

export interface Relief {
  heights: Float32Array;
  /** Height added by mountains (inland peaks / edge ranges) per cell: 0 on open ground. */
  mountain: Float32Array;
}

export function buildRelief(N: number, play: PlayArea, input: ReliefInput): Relief {
  const relief = { heights: new Float32Array(N * N), mountain: new Float32Array(N * N) };
  buildReliefRows(N, play, input, relief, 0, N);
  return relief;
}

/** Fills rows j0..j1-1 of `out`. Every cell is independent, so rows can be built in any order. */
export function buildReliefRows(N: number, play: PlayArea, input: ReliefInput, out: Relief, j0: number, j1: number): void {
  const { heights, mountain } = out;
  const cell = { height: 0, mountain: 0 };
  const span = input.span;
  for (let j = j0; j < j1; j++) {
    const v = (j - play.j0) / span;
    for (let i = 0; i < N; i++) {
      reliefHeight((i - play.i0) / span, v, input, cell);
      heights[j * N + i] = cell.height;
      mountain[j * N + i] = cell.mountain;
    }
  }
}

function reliefHeight(
  u: number, v: number, { seaSides, ranges, noise, detail, mountains, span }: ReliefInput, out: { height: number; mountain: number },
): void {
  // Domain warp gives less grid-like, more organic shapes.
  const wx = u + 0.06 * fbm(detail, u * 4 + 11.3, v * 4 + 7.1, 3);
  const wy = v + 0.06 * fbm(detail, u * 4 - 3.7, v * 4 + 19.9, 3);

  const sea = seaMask(u, v, seaSides, noise, detail);

  // Kept deliberately low-frequency: wide, gently rolling ground that units can
  // traverse, with mountains confined to a few zones as natural obstacles.
  const base = fbm(noise, wx * 2.4, wy * 2.4, 4, 2, 0.4) * 0.5 + 0.5;
  const hills = fbm(noise, wx * 5 + 40, wy * 5 + 40, 2, 2, 0.4) * 0.5 + 0.5;
  const mountainZone = smoothstep(0.55, 0.8, fbm(detail, u * 1.6 + 50, v * 1.6 + 50, 3) * 0.5 + 0.5);

  // Mountain shapes come from real terrain (cells from the play area centre); the zones only say where.
  const ci = (u - 0.5) * span, cj = (v - 0.5) * span;
  const inlandPeaks = mountainZone > 0 ? INLAND_HEIGHT * floodShape(samplePatch(mountains.inland, ci, cj), mountainZone) : 0;
  const edgePeaks = edgeRangeHeight(u, v, ranges, detail, (r) => samplePatch(mountains.ranges[r.index], ci, cj));
  // Bigger maps carry taller mountains in proportion to their side (a 2x wide map: 2x high summits, same slopes).
  const peaks = Math.max(inlandPeaks, edgePeaks) * sea * linearScale(span);
  const land = 1.5 + base * base * 12 + hills * 3 * base + peaks;
  const seaFloor = -10 + fbm(detail, u * 6 + 300, v * 6 + 300, 2) * 3;
  out.height = lerp(seaFloor, land, sea);
  out.mountain = peaks;
}
