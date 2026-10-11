// Terrain generator entry point. The work is done by the generator pipeline (pipeline/): an ordered list of
// stages (layout -> relief -> rivers -> bases -> cities -> roads -> buildings -> cover -> rocks -> trees) over one shared context,
// each yielding its results as pieces finish so a renderer can show the map while it is being made.
//
// The grid covers the play area plus `pad` cells on every side, generated the same way
// (rivers and exit roads start at the grid's outer edge, forests, cover...). Only edge
// mountain ranges (which start at the play area's border and run outward) and player
// bases (inside the play area) are tied to the play area.

import { runPipeline } from './pipeline/run.ts';
import type { Terrain, TerrainOptions } from './pipeline/types.ts';
import type { MountainLibrary } from './mountains/library.ts';

export { SIDES, SNOW_LINE, WATER_LEVEL, type PlayArea, type Side } from './types.ts';
export { sampleGrid } from './grid.ts';
export { ROCK_VARIANTS, type Rock } from './modules/rocks.ts';
export type { River } from './modules/rivers.ts';
export * from './modules/roads/index.ts';
export type { Lighthouse, RadioTower } from './modules/landmarks.ts';
export type { PowerGrid, PowerLine, PowerSite, PowerSiteKind, Pylon, UtilityPole } from './modules/power.ts';
export { INSULATOR, PLANT_SIZE, POLE_SLOTS, PYLON_ARMS, PYLON_PEAK, SUBSTATION_SIZE, pylonAttach, siteGantry, siteScale, siteToWorld } from './modules/power.ts';
export { PLAYER_SLOTS, type Base } from './modules/bases.ts';
export { TREE_TYPES, type Tree, type TreeCover, type TreeType } from './modules/trees.ts';
export { BUILDING_TYPES, type Building, type BuildingCondition, type BuildingType, type City, type Crane, type ParkingLot } from './buildings/types.ts';
export { buildingSpec, type BuildingSpec, type BuildingLight, type Part, type PartKind, type WindowGrid, type DoorSet } from './buildings/spec.ts';
export { BuildingState, type BuildingStateListener } from './buildings/state.ts';
export type { Terrain, TerrainMeta, TerrainOptions, GenEvent, GenStageName } from './pipeline/types.ts';
export { GEN_STAGES } from './pipeline/types.ts';
export { runPipeline } from './pipeline/run.ts';

export { MOUNTAIN_PATCHES, fetchMountainLibrary, type MountainLibrary } from './mountains/library.ts';

/**
 * Generate a terrain from an integer seed in one go (drains the generator pipeline). `mountains` = the real
 * mountain heightmaps (`fetchMountainLibrary`, or `loadMountainLibrary` from mountains/node.ts in Node).
 * Pure and deterministic: same (seed, size, cell, pad) -> identical output.
 */
export function generateTerrain(seed: number, mountains: MountainLibrary, options: TerrainOptions = {}): Terrain {
  const run = runPipeline(seed, mountains, options);
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
  }
}
