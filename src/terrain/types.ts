// Shared constants and small types used across terrain generator modules.

export const SIDES = ['north', 'east', 'south', 'west'] as const;
export type Side = (typeof SIDES)[number];

export const WATER_LEVEL = 0;

/**
 * Height (m) around which the ground turns to snow (terrain / rock shaders). Snow patches start up to ~12 m lower
 * (macro noise), so generation keeps things that shouldn't stand in snow below SNOW_LINE - SNOW_MARGIN.
 */
export const SNOW_LINE = 80;
export const SNOW_MARGIN = 12;

/** Grid-space point [x, y] (x along +X / i, y along +Z / j). */
export type Point = [number, number];

export interface GridPoint {
  x: number;
  y: number;
}

/**
 * The playable square inside the generated grid, in grid cells (inclusive). The grid extends past it
 * on every side with the same kind of terrain (rivers, roads, forests...), so the map border never shows.
 */
export interface PlayArea {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}
