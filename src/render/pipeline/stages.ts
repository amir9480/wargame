// Render stages: what each generator event turns into on screen. A stage stores the event's data in the live
// map right away (so later events and queries see it) and queues the mesh work as jobs, in this order:
//
//   ground  -> terrain chunks, map-edge skirt, height / cover textures (every heights update, nearest chunks first)
//   bases   -> base build-area overlays (re-draped after each heights update)
//   roads   -> road / railway ribbons per type, then bridges
//   buildings -> building meshes per chunk (nearest first), then the gas station lights
//   props   -> rocks, then trees, band by band (generation order: cosmetic random streams depend on it)
//   lights  -> street lights (need the finished roads, rocks and trees); sidewalks, car parks, traffic lights; the wet
//              mask for light reflections

import type { GenEvent, Terrain } from '../../terrain/generate.ts';
import type { ChunkGrid } from '../culling.ts';
import type { GroundLayer } from '../ground.ts';
import type { RockLayer } from '../rocks.ts';
import type { RoadLayer } from '../roads.ts';
import type { TreeLayer } from '../trees.ts';
import type { BaseLayer } from '../bases.ts';
import type { StreetLightLayer } from '../streetlights.ts';
import type { BuildingLayer } from '../buildings/layer.ts';
import type { UrbanLayer } from '../urban.ts';
import type { LandmarkLayer } from '../landmarks.ts';
import type { LightField } from '../lights.ts';
import { buildWetMask } from '../wetmask.ts';
import type { JobQueue } from './queue.ts';

/** Job ranks: render stage order. */
export const RANK = { ground: 0, bases: 1, roads: 2, buildings: 3, props: 4, lights: 5, finish: 6 } as const;

export interface RenderLayers {
  ground: GroundLayer;
  rocks: RockLayer;
  roads: RoadLayer;
  trees: TreeLayer;
  bases: BaseLayer;
  streetLights: StreetLightLayer;
  buildings: BuildingLayer;
  urban: UrbanLayer;
  landmarks: LandmarkLayer;
  lights: LightField;
}

export interface RenderContext {
  /** The map being built: filled in as events arrive (complete once `done` is handled). */
  map: Terrain;
  grid: ChunkGrid;
  layers: RenderLayers;
  queue: JobQueue;
  /** Counts props bands, for unique job keys. */
  bands: number;
  /** Called by the last job of the map. */
  finish(): void;
}

type Handler<K extends GenEvent['kind']> = (event: Extract<GenEvent, { kind: K }>, ctx: RenderContext) => void;
type Handlers = { [K in GenEvent['kind']]?: Handler<K> };

export const RENDER_STAGES: Handlers = {
  heights({ j0, j1, data }, ctx) {
    const { ground } = ctx.layers;
    const { chunks, edge } = ground.applyHeights(j0, j1, data);
    for (const key of chunks)
      ctx.queue.add(`ground:${key}`, { rank: RANK.ground, at: ground.chunkCenter(key), run: () => ground.buildChunk(key) });
    if (edge) ctx.queue.add('ground:edge', { rank: RANK.ground, run: () => ground.buildEdge() });
    if (ctx.map.bases.length) queueBases(ctx);
  },

  rivers({ rivers }, ctx) {
    ctx.map.rivers = rivers;
    ctx.queue.add('streams', { rank: RANK.ground, run: () => ctx.layers.ground.buildStreams(rivers) });
  },

  bases({ bases }, ctx) {
    ctx.map.bases = bases;
    queueBases(ctx);
  },

  cities({ cities }, ctx) {
    ctx.map.cities = cities;
  },

  buildings({ buildings, parking }, ctx) {
    ctx.map.buildings = buildings;
    ctx.map.parking = parking;
    const layer = ctx.layers.buildings;
    for (const job of layer.setBuildings(buildings, ctx.grid))
      ctx.queue.add(`buildings:${job.key}`, { rank: RANK.buildings, at: job.at, run: job.run });
    ctx.queue.add('buildings:lights', { rank: RANK.lights, run: () => layer.buildLights() });
  },

  landmarks({ lighthouses, towers }, ctx) {
    ctx.map.lighthouses = lighthouses;
    ctx.map.towers = towers;
    ctx.queue.add('landmarks', { rank: RANK.lights, run: () => ctx.layers.landmarks.build(lighthouses, towers, ctx.grid) });
  },

  roads({ roads }, ctx) {
    ctx.map.roads = roads;
    ctx.layers.roads.steps(ctx.map, ctx.grid).forEach((run, i) => ctx.queue.add(`roads:${i}`, { rank: RANK.roads, run }));
  },

  cover({ j0, j1, data }, ctx) {
    ctx.map.dirt.set(data, j0 * ctx.map.size);
    ctx.layers.ground.applyCover(j0, j1, data);
  },

  rocks({ rocks }, ctx) {
    ctx.map.rocks.push(...rocks);
    ctx.queue.add(`props:${ctx.bands++}`, { rank: RANK.props, run: () => ctx.layers.rocks.add(ctx.map, rocks, ctx.grid) });
  },

  trees({ type, trees }, ctx) {
    ctx.map.trees.type = type;
    ctx.map.trees.trees.push(...trees);
    ctx.queue.add(`props:${ctx.bands++}`, {
      rank: RANK.props,
      run: () => {
        ctx.layers.trees.add(type, trees, ctx.grid);
        ctx.layers.ground.addCanopy(trees);
      },
    });
  },

  done({ terrain }, ctx) {
    // The streamed fields already match; take the rest (mountain field, land ratio...). The live heightmap stays.
    Object.assign(ctx.map, { ...terrain, heights: ctx.map.heights });
    ctx.queue.add('lights', { rank: RANK.lights, run: () => ctx.layers.streetLights.build(ctx.map, ctx.grid) });
    ctx.queue.add('urban', { rank: RANK.lights, run: () => ctx.layers.urban.build(ctx.map, ctx.grid) });
    ctx.queue.add('wetmask', { rank: RANK.lights, run: () => ctx.layers.lights.setWetMask(buildWetMask(ctx.map), ctx.map.worldSize) });
    ctx.queue.add('finish', { rank: RANK.finish, run: () => ctx.finish() });
  },
};

function queueBases(ctx: RenderContext): void {
  ctx.queue.add('bases', { rank: RANK.bases, run: () => ctx.layers.bases.build(ctx.map) });
}
