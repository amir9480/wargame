// Runs the generator stages in order over one shared context. The pipeline is a generator: the caller decides
// how to drive it (all at once in Node, event by event in a worker that posts each one to the renderer).

import { createNoise2D } from '../../core/noise.ts';
import { STAGE, stageRng } from '../seeds.ts';
import { WATER_LEVEL } from '../types.ts';
import { GENERATOR_STAGES } from './stages.ts';
import type { MountainLibrary } from '../mountains/library.ts';
import { GEN_STAGES, type GenContext, type GenEvent, type Terrain, type TerrainOptions } from './types.ts';

/** Rows per band in chunked stages: one render chunk row (render/culling.ts CHUNK_CELLS). */
export const GEN_BAND = 32;

/**
 * Generates a terrain from an integer seed, yielding progress events; returns the finished terrain
 * (also sent as the last event, `done`). Pure and deterministic: same (seed, size, cell, pad) and the same
 * mountain heightmaps (mountains/library.ts, loaded once beforehand) -> identical output.
 */
export function* runPipeline(
  seed: number, mountains: MountainLibrary, { size = 256, cell = 2, pad = 64 }: TerrainOptions = {},
): Generator<GenEvent, Terrain> {
  const ctx = createContext(seed >>> 0, size, cell, pad, mountains);
  const count = GEN_STAGES.length;
  for (const stage of GENERATOR_STAGES) {
    yield { kind: 'stage', stage: stage.name, index: GEN_STAGES.indexOf(stage.name), count };
    yield* stage.run(ctx);
  }
  yield { kind: 'stage', stage: 'finish', index: count - 1, count };
  const terrain = assemble(ctx);
  yield { kind: 'done', terrain };
  return terrain;
}

function createContext(seed: number, size: number, cell: number, pad: number, mountainLibrary: MountainLibrary): GenContext {
  const N = size + 2 * pad;
  return {
    seed,
    N,
    cell,
    size,
    play: { i0: pad, j0: pad, i1: pad + size - 1, j1: pad + size - 1 },
    span: size - 1,
    band: GEN_BAND,
    noise: createNoise2D(stageRng(seed, STAGE.shape)),
    detail: createNoise2D(stageRng(seed, STAGE.detail)),
    mountainLibrary,
    seaSides: [],
    ranges: [],
    heights: new Float32Array(N * N),
    mountain: new Float32Array(N * N),
    rivers: [],
    riverMask: new Uint8Array(N * N),
    riverPaths: [],
    streamMask: new Uint8Array(N * N),
    bases: [],
    cities: [],
    citySites: [],
    cityMask: new Uint8Array(N * N),
    roads: { nodes: [], edges: [] },
    buildings: [],
    parking: [],
    lighthouses: [],
    towers: [],
    power: { sites: [], lines: [], poles: [], links: [] },
    builtMask: new Uint8Array(N * N),
    roadMask: new Uint8Array(N * N),
    roadLevel: new Uint8Array(N * N),
    clear: new Uint8Array(N * N),
    dirt: new Float32Array(N * N),
    rocks: [],
    trees: { type: 'pine', trees: [] },
  };
}

function assemble(ctx: GenContext): Terrain {
  const { N, play, heights } = ctx;
  let land = 0;
  for (let j = play.j0; j <= play.j1; j++)
    for (let i = play.i0; i <= play.i1; i++) if (heights[j * N + i] > WATER_LEVEL) land++;

  return {
    seed: ctx.seed,
    size: N,
    cell: ctx.cell,
    worldSize: (N - 1) * ctx.cell,
    play,
    playSize: ctx.span * ctx.cell,
    waterLevel: WATER_LEVEL,
    heights,
    seaSides: ctx.seaSides.map((s) => s.side),
    mountainSides: ctx.ranges.map((r) => r.side),
    rivers: ctx.rivers,
    bases: ctx.bases,
    roads: ctx.roads,
    cities: ctx.cities,
    buildings: ctx.buildings,
    parking: ctx.parking,
    lighthouses: ctx.lighthouses,
    towers: ctx.towers,
    power: ctx.power,
    rocks: ctx.rocks,
    dirt: ctx.dirt,
    mountain: ctx.mountain,
    trees: ctx.trees,
    landRatio: land / (ctx.size * ctx.size),
  };
}
