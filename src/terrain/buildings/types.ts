// Public building / city data. World units (map centred on the origin, y up), like the road network.

export const BUILDING_TYPES = ['villa', 'apartment', 'office', 'market', 'gas', 'warehouse', 'farmhouse', 'barn'] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

/**
 * Condition fixed by the map seed: `abandoned` buildings are damaged and dark (left behind before the battle);
 * `construction` ones were never finished: a bare concrete frame (columns, floor slabs) with a tower crane, on the
 * building's footprint. Destruction during play is separate (see BuildingState), so every client starts from the same map.
 */
export type BuildingCondition = 'intact' | 'abandoned' | 'construction';

export interface Building {
  /** Index into Terrain.buildings (and bit index in BuildingState). */
  id: number;
  /** Seed of the building itself: `buildingSpec(seed, type)` rebuilds its exact shape, colours and floors. */
  seed: number;
  type: BuildingType;
  /** Footprint centre; y is the levelled ground height under it. */
  x: number;
  y: number;
  z: number;
  /**
   * Rotation about +Y (radians). The building's local +Z (its front, facing the road) points along
   * (sin yaw, cos yaw) in world XZ; local +X (along its width) along (cos yaw, -sin yaw).
   */
  yaw: number;
  /** Footprint along local X / Z and height of the highest part, metres. */
  width: number;
  depth: number;
  height: number;
  floors: number;
  condition: BuildingCondition;
  /** City (index into Terrain.cities) it belongs to, or -1 for a rural building. */
  city: number;
  /** Tower crane over a construction site (some of them), else null. */
  crane: Crane | null;
}

/**
 * Tower crane of a construction site (world units): mast standing on the building's pad, a straight jib + counter-jib
 * beam at `height` above its foot. Placed so that beam clears the ground (trees, lamps, signals), every other building
 * and every other crane (see terrain/buildings/crane.ts).
 */
export interface Crane {
  /** Mast foot; y = the building's levelled ground. */
  x: number;
  y: number;
  z: number;
  /** Top of the mast / underside of the jib above the foot (m). */
  height: number;
  /** Jib (forward) and counter-jib lengths from the mast (m). */
  jib: number;
  counter: number;
  /** Jib heading: it points along (sin heading, cos heading) in world XZ (same convention as Building.yaw). */
  heading: number;
}

/**
 * Town car park: an asphalt rectangle facing its street (same frame as a building: local +Z = front), two rows of
 * bays along local X with an aisle between them and an entrance gap in the front row. Cars on it are cosmetic.
 */
export interface ParkingLot {
  id: number;
  /** Centre; y = levelled ground height. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  width: number;
  depth: number;
  /** Bays per row. */
  bays: number;
  city: number;
  /** Cosmetic seed (which bays hold cars, their colours). */
  seed: number;
}

export interface City {
  id: number;
  /** Centre, world units; y = levelled ground height there. */
  x: number;
  y: number;
  z: number;
  /** Rough radius of the built-up area, metres. */
  radius: number;
  /** Street grid rotation (radians) and block size (metres). */
  angle: number;
  block: number;
}
