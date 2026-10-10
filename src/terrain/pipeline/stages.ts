// The generator stages, in pipeline order. Each one reads what earlier stages left in the context, adds its
// own part and yields events as pieces finish (row bands for per-cell work, whole results for global steps).
//
//   layout  -> which sides end in open sea, mountain ranges along land edges
//   relief  -> base heightmap (row bands, centre first), then blurred
//   rivers  -> carves rivers into the heightmap
//   bases   -> 4 player start areas, far apart on flat open ground (levelled)
//   cities  -> 0..2 towns in contested ground (levelled a little), each with a street grid
//   roads   -> city streets, roads linking the bases and cities (plus exits, bridges, railway); flattens ground under them
//   buildings -> buildings along the roads (dense in towns, hamlets and farms elsewhere), each on a levelled pad
//   landmarks -> 0..4 lighthouses on the beaches, 0..3 telecommunication towers on the mountains (small levelled pads)
//   cover   -> dirt vs grass ground cover (row bands)
//   rocks   -> boulders over the finished ground, off the roads (row bands)
//   trees   -> forests and lone trees, one species per map (row bands)
//
// Each module gets its own seeded random stream (see seeds.ts), so a module can be tuned, added or removed
// without changing what the others produce. Banded stages that draw random numbers run their bands top to
// bottom, so the stream is consumed exactly as in a single pass.

import { createNoise2D } from '../../core/noise.ts';
import { STAGE, stageRng } from '../seeds.ts';
import { blur } from '../grid.ts';
import { pickSeaSides } from '../modules/sea.ts';
import { pickEdgeRanges } from '../modules/ranges.ts';
import { buildReliefRows } from '../modules/relief.ts';
import { pickPatchView } from '../mountains/library.ts';
import { SIDES } from '../types.ts';
import { carveRivers, carveStreams, wetRiverBeds } from '../modules/rivers.ts';
import { placeBases } from '../modules/bases.ts';
import { placeCities } from '../modules/cities.ts';
import { placeBuildings } from '../modules/buildings.ts';
import { placeLighthouses, placeTowers } from '../modules/landmarks.ts';
import { generateRoads } from '../modules/roads/index.ts';
import { coverBuilder } from '../modules/cover.ts';
import { rockScatter } from '../modules/rocks.ts';
import { treePlanter } from '../modules/trees.ts';
import { WATER_LEVEL } from '../types.ts';
import type { GenContext, GenEvent, GenStage } from './types.ts';

/** Row bands [j0, j1) covering the grid, top to bottom. */
function bands({ N, band }: GenContext): [number, number][] {
  const out: [number, number][] = [];
  for (let j0 = 0; j0 < N; j0 += band) out.push([j0, Math.min(N, j0 + band)]);
  return out;
}

/** Event carrying a copy of rows j0..j1-1 of the heightmap (whole grid by default). */
function heightsEvent({ N, heights }: GenContext, j0 = 0, j1 = N): GenEvent {
  return { kind: 'heights', j0, j1, data: heights.slice(j0 * N, j1 * N) };
}

const layout: GenStage = {
  name: 'layout',
  *run(ctx) {
    ctx.seaSides = pickSeaSides(stageRng(ctx.seed, STAGE.sea));
    ctx.ranges = pickEdgeRanges(ctx.seaSides, stageRng(ctx.seed, STAGE.ranges));
    const { seed, N, cell, size, play } = ctx;
    yield {
      kind: 'meta',
      meta: {
        seed,
        size: N,
        cell,
        worldSize: (N - 1) * cell,
        play,
        playSize: (size - 1) * cell,
        waterLevel: WATER_LEVEL,
        seaSides: ctx.seaSides.map((s) => s.side),
        mountainSides: ctx.ranges.map((r) => r.side),
      },
    };
  },
};

const relief: GenStage = {
  name: 'relief',
  *run(ctx) {
    const { seed, N, play, span, seaSides, ranges, noise, detail, mountainLibrary: lib } = ctx;
    // Real mountain shapes: one seeded view for the inland peaks, one per edge range (salt 1 + side index).
    const mountains = { inland: pickPatchView(lib, seed, 0, N), ranges: SIDES.map((_, k) => pickPatchView(lib, seed, 1 + k, N)) };
    // Cells are independent: build the bands from the centre outward, where the camera usually looks.
    const order = bands(ctx).sort(([a], [b]) => Math.abs(a + ctx.band / 2 - N / 2) - Math.abs(b + ctx.band / 2 - N / 2));
    for (const [j0, j1] of order) {
      buildReliefRows(N, play, { seaSides, ranges, noise, detail, mountains, span }, ctx, j0, j1);
      yield heightsEvent(ctx, j0, j1);
    }
    blur(ctx.heights, N, 1, 2);
    yield heightsEvent(ctx);
  },
};

const rivers: GenStage = {
  name: 'rivers',
  *run(ctx) {
    const { N, play, heights } = ctx;
    const result = carveRivers(
      heights, ctx.mountain, N, ctx.cell, play, ctx.seaSides, ctx.ranges.map((r) => r.side), stageRng(ctx.seed, STAGE.rivers), ctx.detail,
    );
    blur(heights, N, 1, 2); // soften carved river banks
    wetRiverBeds(heights, result.mask);
    ctx.streamMask = carveStreams(heights, N, result.streams); // mountain streams: crisp channels, after the blur
    ctx.rivers = result.rivers;
    ctx.riverMask = result.mask;
    ctx.riverPaths = result.paths;
    yield heightsEvent(ctx);
    yield { kind: 'rivers', rivers: ctx.rivers };
  },
};

const bases: GenStage = {
  name: 'bases',
  *run(ctx) {
    const { N, cell, play, heights, riverMask, mountain } = ctx;
    ctx.bases = placeBases({ N, cell, play, heights, riverMask, mountain }, stageRng(ctx.seed, STAGE.bases));
    wetRiverBeds(heights, riverMask); // levelling next to a base can lift a river bed
    yield heightsEvent(ctx);
    yield { kind: 'bases', bases: ctx.bases };
  },
};

const cities: GenStage = {
  name: 'cities',
  *run(ctx) {
    const { N, cell, play, heights, riverMask, mountain, bases } = ctx;
    const result = placeCities({ N, cell, play, heights, riverMask, mountain, bases }, stageRng(ctx.seed, STAGE.cities));
    ctx.cities = result.cities;
    ctx.citySites = result.sites;
    ctx.cityMask = result.mask;
    if (result.cities.length) {
      wetRiverBeds(heights, riverMask);
      yield heightsEvent(ctx);
    }
    yield { kind: 'cities', cities: ctx.cities };
  },
};

const roads: GenStage = {
  name: 'roads',
  *run(ctx) {
    const { N, cell, play, heights, riverMask, riverPaths } = ctx;
    const baseCells = ctx.bases.map((b) => ({ x: (b.i0 + b.i1) / 2, y: (b.j0 + b.j1) / 2, half: (b.i1 - b.i0) / 2 }));
    const cityStreets = ctx.citySites.map(({ x, y, radius, nodes, streets }) => ({ x, y, radius, nodes, streets }));
    const roadRng = stageRng(ctx.seed, STAGE.roads);
    const result = generateRoads(
      { N, cell, play, heights, mountain: ctx.mountain, riverMask, streamMask: ctx.streamMask, riverPaths, seaSides: ctx.seaSides.map((s) => s.side), bases: baseCells, cities: cityStreets },
      roadRng,
      createNoise2D(roadRng),
      stageRng(ctx.seed, STAGE.rails),
    );
    ctx.roads = result.network;
    ctx.roadMask = result.mask;
    ctx.roadLevel = result.level;
    // Rocks and trees keep off roads, mountain streams and base build areas.
    ctx.clear = Uint8Array.from(result.mask, (v, k) => v || ctx.streamMask[k]);
    for (const b of ctx.bases)
      for (let j = Math.max(0, b.j0 - 3); j <= Math.min(N - 1, b.j1 + 3); j++)
        for (let i = Math.max(0, b.i0 - 3); i <= Math.min(N - 1, b.i1 + 3); i++) ctx.clear[j * N + i] = 1;
    yield heightsEvent(ctx);
    yield { kind: 'roads', roads: ctx.roads };
  },
};

const buildings: GenStage = {
  name: 'buildings',
  *run(ctx) {
    const { N, cell, heights, riverMask, roadMask, roadLevel, mountain, bases, roads, citySites, cityMask } = ctx;
    const rng = stageRng(ctx.seed, STAGE.buildings);
    const result = placeBuildings(
      { N, cell, heights, riverMask, roadMask, roadLevel, mountain, bases, roads, cities: citySites, cityMask },
      rng,
      createNoise2D(rng),
    );
    ctx.buildings = result.buildings;
    ctx.parking = result.parking;
    ctx.builtMask = result.occupied;
    // Rocks and trees keep off the buildings (in a clearing around each) and out of the towns.
    for (let k = 0; k < ctx.clear.length; k++) if (result.clearing[k] || cityMask[k]) ctx.clear[k] = 1;
    if (result.buildings.length) yield heightsEvent(ctx);
    yield { kind: 'buildings', buildings: ctx.buildings, parking: ctx.parking };
  },
};

const landmarks: GenStage = {
  name: 'landmarks',
  *run(ctx) {
    const { N, cell, play, heights, mountain, riverMask, streamMask, clear, cityMask, builtMask } = ctx;
    // Taken ground: roads, bases, towns and buildings (the clearing marks only exist once the buildings are placed).
    const taken = Uint8Array.from(clear, (v, k) => v || cityMask[k] || builtMask[k]);
    const input = { N, cell, play, heights, mountain, riverMask, streamMask, clear: taken };
    const lighthouses = placeLighthouses(input, stageRng(ctx.seed, STAGE.lighthouses), ctx.seaSides.length);
    // Towers keep clear of the lighthouses' pads too.
    for (let k = 0; k < taken.length; k++) if (lighthouses.clearing[k]) taken[k] = 1;
    const towers = placeTowers(input, stageRng(ctx.seed, STAGE.towers));
    ctx.lighthouses = lighthouses.items;
    ctx.towers = towers.items;
    for (let k = 0; k < ctx.clear.length; k++) if (lighthouses.clearing[k] || towers.clearing[k]) ctx.clear[k] = 1;
    if (ctx.lighthouses.length || ctx.towers.length) yield heightsEvent(ctx);
    yield { kind: 'landmarks', lighthouses: ctx.lighthouses, towers: ctx.towers };
  },
};

const cover: GenStage = {
  name: 'cover',
  *run(ctx) {
    const { N, cell, span, heights, riverMask, roadMask, builtMask } = ctx;
    const builder = coverBuilder({ N, cell, span, heights, riverMask, roadMask, builtMask }, createNoise2D(stageRng(ctx.seed, STAGE.cover)));
    ctx.dirt = builder.dirt;
    for (const [j0, j1] of bands(ctx)) {
      builder.rows(j0, j1);
      yield { kind: 'cover', j0, j1, data: ctx.dirt.slice(j0 * N, j1 * N) };
    }
  },
};

const rocks: GenStage = {
  name: 'rocks',
  *run(ctx) {
    const rockRng = stageRng(ctx.seed, STAGE.rocks);
    const scan = rockScatter(ctx.heights, ctx.N, ctx.cell, rockRng, createNoise2D(rockRng), { blocked: ctx.clear, riverMask: ctx.riverMask });
    ctx.rocks = [];
    for (const [j0, j1] of bands(ctx)) {
      const band = scan(j0, j1);
      ctx.rocks.push(...band);
      yield { kind: 'rocks', rocks: band };
    }
  },
};

const trees: GenStage = {
  name: 'trees',
  *run(ctx) {
    const { N, cell, span, heights, mountain, riverMask, roadMask, clear, dirt } = ctx;
    const treeRng = stageRng(ctx.seed, STAGE.trees);
    const planter = treePlanter(
      { N, cell, span, heights, mountain, riverMask, roadMask, clear, dirt, rocks: ctx.rocks },
      treeRng,
      createNoise2D(treeRng),
    );
    ctx.trees = { type: planter.type, trees: [] };
    for (const [j0, j1] of bands(ctx)) {
      const band = planter.rows(j0, j1);
      ctx.trees.trees.push(...band);
      yield { kind: 'trees', type: planter.type, trees: band };
    }
  },
};

/** Generator stages in pipeline order (later stages read and modify earlier results). */
export const GENERATOR_STAGES: readonly GenStage[] = [layout, relief, rivers, bases, cities, roads, buildings, landmarks, cover, rocks, trees];
