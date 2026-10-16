// Unit definitions. `id` values are part of saves/wire format: NEVER renumber, only append.
export interface UnitDef {
  id: number;
  name: string;
  label: string;
  /** Movement class used by the nav grid. */
  mover: 'foot' | 'wheeled' | 'tracked';
  /** m/s */
  speed: number;
  hp: number;
  cost: number;
  /** Seconds to produce at full power. */
  buildTime: number;
  /** Structure type that produces it (0 = not buildable). */
  producedBy: number;
  /** Weapon: range (m) and damage per second; 0 = unarmed. */
  range: number;
  dps: number;
  /** Selection / hit radius (m). */
  radius: number;
}

export const UNITS: readonly UnitDef[] = [
  { id: 1, name: 'rifleman', label: 'Rifleman', mover: 'foot', speed: 4.2, hp: 100, cost: 100, buildTime: 6, producedBy: 103, range: 22, dps: 12, radius: 0.6 },
  { id: 2, name: 'rocketTrooper', label: 'Rocket Trooper', mover: 'foot', speed: 3.8, hp: 100, cost: 250, buildTime: 9, producedBy: 103, range: 30, dps: 22, radius: 0.6 },
  { id: 3, name: 'supplyTruck', label: 'Supply Truck', mover: 'wheeled', speed: 9, hp: 250, cost: 400, buildTime: 12, producedBy: 104, range: 0, dps: 0, radius: 1.6 },
  { id: 4, name: 'battleTank', label: 'Battle Tank', mover: 'tracked', speed: 7, hp: 600, cost: 700, buildTime: 25, producedBy: 104, range: 40, dps: 45, radius: 2.6 },
];

/** Drawn size of every unit relative to its model (models are life-size; the map is large, so units are scaled down). */
export const UNIT_SCALE = 0.6;

export const UNIT_BY_ID =new Map(UNITS.map((u) => [u.id, u]));
