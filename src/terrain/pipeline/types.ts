// Generator pipeline types: the map being built (GenContext), what a stage reports while it works (GenEvent)
// and the finished map (Terrain).

import type { Noise2D } from '../../core/noise.ts';
import type { PlayArea, Point, Side } from '../types.ts';
import type { SeaSide } from '../modules/sea.ts';
import type { EdgeRange } from '../modules/ranges.ts';
import type { MountainLibrary } from '../mountains/library.ts';
import type { River } from '../modules/rivers.ts';
import type { Base } from '../modules/bases.ts';
import type { RoadNetwork } from '../modules/roads/index.ts';
import type { Rock } from '../modules/rocks.ts';
import type { Tree, TreeCover, TreeType } from '../modules/trees.ts';
import type { CitySite } from '../modules/cities.ts';
import type { Building, City, ParkingLot } from '../buildings/types.ts';
import type { Lighthouse, RadioTower } from '../modules/landmarks.ts';
import type { PowerGrid } from '../modules/power.ts';

export interface Terrain {
  seed: number;
  /** Vertices per grid edge (play area + padding on both sides). */
  size: number;
  /** World units per grid step. */
  cell: number;
  /** Extent of the whole grid in world units (centred on the origin). */
  worldSize: number;
  /** Playable square in grid cells (centred); everything outside it is scenery of the same kind. */
  play: PlayArea;
  /** Extent of the play area in world units (centred on the origin). */
  playSize: number;
  waterLevel: number;
  /** Row-major: heights[j * size + i], i along +X (west->east), j along +Z (north->south). */
  heights: Float32Array;
  seaSides: Side[];
  /** Land edges bordered by a mountain range. */
  mountainSides: Side[];
  rivers: River[];
  /** Player start areas (slots 0..3, clockwise), each a levelled square build area. */
  bases: Base[];
  /** Road graph: nodes (bases, exits, junctions) and edges with curve points and bridges. */
  roads: RoadNetwork;
  /** 0..2 compact built-up areas (their streets are part of `roads`). */
  cities: City[];
  /** Every building, in id order (shape: buildingSpec(seed, type)); destruction during play lives in BuildingState. */
  buildings: Building[];
  /** Town car parks (levelled asphalt lots beside the streets). */
  parking: ParkingLot[];
  /** 0..4 lighthouses on the beaches (none without a sea side). */
  lighthouses: Lighthouse[];
  /** 0..3 telecommunication towers on the mountains. */
  towers: RadioTower[];
  /** Power plants and substations, high-voltage pylon lines and roadside utility poles (a plant whenever there is a city). */
  power: PowerGrid;
  rocks: Rock[];
  /** Dirt amount per grid cell (0 = grass .. 1 = bare dirt), same layout as heights. */
  dirt: Float32Array;
  /** Height mountains add per cell (0 = open ground, > ~2 = mountain), same layout as heights. */
  mountain: Float32Array;
  /** Tree species for this map and every tree. */
  trees: TreeCover;
  /** Share of the play area that is land. */
  landRatio: number;
}

export interface TerrainOptions {
  /** Vertices per play area edge. */
  size?: number;
  cell?: number;
  /** Extra cells generated on each side of the play area. */
  pad?: number;
}

/** What is known about a map before any stage ran (grid layout, coasts, edge ranges). */
export type TerrainMeta = Pick<
  Terrain,
  'seed' | 'size' | 'cell' | 'worldSize' | 'play' | 'playSize' | 'waterLevel' | 'seaSides' | 'mountainSides'
>;

/** Generator stages, in pipeline order. */
export const GEN_STAGES = ['layout', 'relief', 'rivers', 'bases', 'cities', 'roads', 'buildings', 'landmarks', 'power', 'cover', 'rocks', 'trees', 'finish'] as const;
export type GenStageName = (typeof GEN_STAGES)[number];

/**
 * Progress reports of the pipeline, in order. All plain data (typed arrays, plain objects), so they can be
 * posted from a worker. Row ranges are grid rows j0..j1-1; `data` holds exactly those rows.
 */
export type GenEvent =
  /** A stage starts (`index` of `count`). */
  | { kind: 'stage'; stage: GenStageName; index: number; count: number }
  | { kind: 'meta'; meta: TerrainMeta }
  /** New heights for rows j0..j1-1 (the whole grid after a stage that reshapes the ground). */
  | { kind: 'heights'; j0: number; j1: number; data: Float32Array }
  | { kind: 'rivers'; rivers: River[] }
  | { kind: 'bases'; bases: Base[] }
  | { kind: 'cities'; cities: City[] }
  | { kind: 'roads'; roads: RoadNetwork }
  | { kind: 'buildings'; buildings: Building[]; parking: ParkingLot[] }
  | { kind: 'landmarks'; lighthouses: Lighthouse[]; towers: RadioTower[] }
  | { kind: 'power'; power: PowerGrid }
  | { kind: 'cover'; j0: number; j1: number; data: Float32Array }
  /** Rocks / trees of one more row band (in generation order). */
  | { kind: 'rocks'; rocks: Rock[] }
  | { kind: 'trees'; type: TreeType; trees: Tree[] }
  | { kind: 'done'; terrain: Terrain };

/** Shared state the stages read and fill in, in pipeline order. */
export interface GenContext {
  seed: number;
  /** Grid vertices per side (play area + padding). */
  N: number;
  cell: number;
  /** Play area vertices per side. */
  size: number;
  play: PlayArea;
  /** Play area side in cells (size - 1): the unit of play-area-relative noise coordinates. */
  span: number;
  /** Rows per band in chunked stages. */
  band: number;
  noise: Noise2D;
  detail: Noise2D;
  /** Real-world mountain heightmaps the relief takes mountain shapes from. */
  mountainLibrary: MountainLibrary;
  seaSides: SeaSide[];
  ranges: EdgeRange[];
  heights: Float32Array;
  mountain: Float32Array;
  rivers: River[];
  /** River id + 1 per cell, else 0. */
  riverMask: Uint8Array;
  riverPaths: Point[][];
  /** 1 on mountain stream channels (+1 cell): roads, rocks and trees keep off. */
  streamMask: Uint8Array;
  bases: Base[];
  cities: City[];
  citySites: CitySite[];
  /** City id + 1 per cell inside a city. */
  cityMask: Uint8Array;
  roads: RoadNetwork;
  buildings: Building[];
  parking: ParkingLot[];
  lighthouses: Lighthouse[];
  towers: RadioTower[];
  power: PowerGrid;
  /** 1 under buildings and their yards. */
  builtMask: Uint8Array;
  /** 1 on road / rail / bridge cells. */
  roadMask: Uint8Array;
  /** 1 on cells levelled to a road surface or junction pad, incl. town sidewalks (building pads keep off). */
  roadLevel: Uint8Array;
  /** Cells rocks and trees keep off (roads, base areas, cities, buildings). */
  clear: Uint8Array;
  dirt: Float32Array;
  rocks: Rock[];
  trees: TreeCover;
}

export interface GenStage {
  name: GenStageName;
  /** Does the stage's work, yielding events as pieces of it finish. */
  run(ctx: GenContext): Iterable<GenEvent>;
}
