// Structure definitions. `id` values start at 100 (type >= 100 means structure) and are NEVER renumbered.
export interface StructureDef {
  id: number;
  name: string;
  label: string;
  /** Footprint in metres (width x depth). */
  width: number;
  depth: number;
  height: number;
  /** Seconds to build at full power. */
  buildTime: number;
  cost: number;
  hp: number;
  /** Power produced (+) or consumed (-) once completed. */
  power: number;
  /** Credits per second once completed. */
  income: number;
  requires: readonly number[];
  /** Weapon (defensive structures). */
  range: number;
  dps: number;
}

export const STRUCTURES: readonly StructureDef[] = [
  { id: 100, name: 'commandCenter', label: 'Command Center', width: 15, depth: 15, height: 9, buildTime: 40, cost: 2000, hp: 1800, power: 0, income: 3, requires: [], range: 0, dps: 0 },
  { id: 101, name: 'powerPlant', label: 'Power Plant', width: 10, depth: 10, height: 8, buildTime: 20, cost: 800, hp: 700, power: 12, income: 0, requires: [100], range: 0, dps: 0 },
  { id: 102, name: 'supplyDepot', label: 'Supply Depot', width: 11, depth: 11, height: 5, buildTime: 25, cost: 1000, hp: 700, power: -2, income: 14, requires: [100], range: 0, dps: 0 },
  { id: 103, name: 'barracks', label: 'Barracks', width: 11, depth: 9, height: 4.5, buildTime: 25, cost: 600, hp: 800, power: -3, income: 0, requires: [101], range: 0, dps: 0 },
  { id: 104, name: 'warFactory', label: 'War Factory', width: 16, depth: 13, height: 7, buildTime: 45, cost: 2000, hp: 1100, power: -6, income: 0, requires: [101, 103], range: 0, dps: 0 },
  { id: 105, name: 'mgTurret', label: 'MG Turret', width: 3, depth: 3, height: 2.5, buildTime: 12, cost: 300, hp: 450, power: -1, income: 0, requires: [103], range: 38, dps: 22 },
];

export const STRUCTURE_BY_ID = new Map(STRUCTURES.map((s) => [s.id, s]));
export const isStructureType = (type: number): boolean => type >= 100;
/** Footprint radius used for overlap tests. */
export const footprintRadius = (s: StructureDef): number => Math.hypot(s.width, s.depth) * 0.42;
