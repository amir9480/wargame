// Heightmap grid helpers shared by the generator modules.
// Layout: h[j * N + i], i along +X (west->east), j along +Z (north->south).

import { lerp } from '../core/noise.ts';
import type { GridPoint, PlayArea, Point, Side } from './types.ts';

/** Bilinear sample at fractional grid coordinates, clamped to the grid. */
export function sampleGrid(h: Float32Array, N: number, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(N - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(N - 2, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const a = h[y0 * N + x0], b = h[y0 * N + x0 + 1];
  const c = h[(y0 + 1) * N + x0], d = h[(y0 + 1) * N + x0 + 1];
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/** In-place 3x3 blur of the interior, blended by `amount`. */
export function blur(h: Float32Array, N: number, amount: number, passes = 1): void {
  for (let p = 0; p < passes; p++) {
    const src = h.slice();
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        let s = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) s += src[(j + dj) * N + i + di];
        const k = j * N + i;
        h[k] = lerp(src[k], s / 9, amount);
      }
    }
  }
}

/** Separable box blur with radius `r` cells; returns a new array. */
export function boxBlur(src: Float32Array, N: number, r: number): Float32Array {
  const tmp = new Float32Array(N * N);
  const out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let d = Math.max(0, i - r); d <= Math.min(N - 1, i + r); d++, c++) s += src[j * N + d];
      tmp[j * N + i] = s / c;
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0, c = 0;
      for (let d = Math.max(0, j - r); d <= Math.min(N - 1, j + r); d++, c++) s += tmp[d * N + i];
      out[j * N + i] = s / c;
    }
  }
  return out;
}

/** Per-cell slope as 1 - normal.y (0 = flat, 1 = vertical), matching the terrain shader. */
export function slopeField(h: Float32Array, N: number, cell: number): Float32Array {
  const out = new Float32Array(N * N);
  const at = (i: number, j: number) =>
    h[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  const ny = 2 * cell;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const nx = at(i - 1, j) - at(i + 1, j);
      const nz = at(i, j - 1) - at(i, j + 1);
      out[j * N + i] = 1 - ny / Math.hypot(nx, ny, nz);
    }
  }
  return out;
}

/** [distance from edge in 0..1, coordinate along edge in 0..1] */
export function edgeCoords(side: Side, u: number, v: number): Point {
  switch (side) {
    case 'north': return [v, u];
    case 'south': return [1 - v, u];
    case 'west': return [u, v];
    case 'east': return [1 - u, v];
  }
}

/**
 * Grid point on the outer edge of the whole grid, `along` measured over the playable
 * span (0 = level with the play area's first row/column, 1 = its last).
 */
export function outerEdgePoint(side: Side, along: number, N: number, play: PlayArea, inset = 0): GridPoint {
  const a = (play.i0 + along * (play.i1 - play.i0)) / (N - 1);
  return edgePoint(side, a, N, inset);
}

/** Grid point on a map edge, optionally `inset` cells in toward the centre. */
export function edgePoint(side: Side, along: number, N: number, inset = 0): GridPoint {
  const m = N - 1;
  switch (side) {
    case 'north': return { x: along * m, y: inset };
    case 'south': return { x: along * m, y: m - inset };
    case 'west': return { x: inset, y: along * m };
    case 'east': return { x: m - inset, y: along * m };
  }
}
