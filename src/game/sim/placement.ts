// Structure placement rules, shared by the authoritative sim (validation) and the client (placement ghost colour),
// so the ghost is green exactly when the sim would accept the order.
import { STRUCTURE_BY_ID, footprintRadius, isStructureType } from '../defs/structures.ts';
import type { NavGrid } from '../nav/navgrid.ts';
import type { EntityStore } from '../store/entities.ts';
import { REJECT } from './messages.ts';

export interface World {
  /** Navigation grid (A* pathfinding, obstacle-aware movement); absent in test worlds, where units move in straight lines. */
  nav?: NavGrid;
  heightAt(x: number, z: number): number;
  /** True when a circle of `radius` metres at (x, z) is flat, dry, and clear of map buildings / rocks. */
  buildable(x: number, z: number, radius: number): boolean;
}

/** Everything is buildable on flat ground (tests). */
export const FLAT_WORLD: World = { heightAt: () => 0, buildable: () => true };

/** How far from an existing completed structure of yours you may build. */
export const BUILD_RADIUS = 90;

export function isComplete(s: EntityStore, i: number): boolean {
  return s.pBase[i] === 65535 && s.pRate[i] === 0;
}

/** REJECT.none (0) when `player` may place a structure of `type` at (x, z) now, else the reason. */
export function checkPlacement(s: EntityStore, world: World, player: number, type: number, x: number, z: number, credits: number): number {
  const def = STRUCTURE_BY_ID.get(type);
  if (!def) return REJECT.invalid;
  const have = new Set<number>();
  let nearOwn = false;
  let ownAny = false;
  const r = footprintRadius(def);
  for (let i = 0; i < s.highWater; i++) {
    if (!s.alive[i] || !isStructureType(s.type[i])) continue;
    const other = STRUCTURE_BY_ID.get(s.type[i])!;
    const dx = s.x[i] - x, dz = s.z[i] - z;
    const d = Math.hypot(dx, dz);
    if (d < r + footprintRadius(other) + 1.5) return REJECT.blocked;
    if (s.owner[i] === player) {
      ownAny = true;
      if (isComplete(s, i)) {
        have.add(s.type[i]);
        if (d <= BUILD_RADIUS) nearOwn = true;
      }
    }
  }
  for (const req of def.requires) if (!have.has(req)) return REJECT.prerequisite;
  if (ownAny && !nearOwn && def.requires.length) return REJECT.range;
  if (credits < def.cost) return REJECT.credits;
  if (!world.buildable(x, z, r)) return REJECT.terrain;
  return REJECT.none;
}
