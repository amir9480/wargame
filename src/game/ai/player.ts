// AI opponent. It only issues Commands (the same validated path as the human) and reads the sim state; it keeps no
// hidden state outside `AIState`, which is plain data so it can be saved with the game.
import { simRng, SIM_STREAM } from '../seeds.ts';
import { STRUCTURE_BY_ID, isStructureType } from '../defs/structures.ts';
import { UNIT_BY_ID } from '../defs/units.ts';
import { BUILD_RADIUS, checkPlacement, isComplete } from '../sim/placement.ts';
import { STATE_IDLE, type Simulation } from '../sim/simulation.ts';
import { TICK_RATE } from '../tuning.ts';

const POWER_PLANT = 101, DEPOT = 102, BARRACKS = 103, FACTORY = 104, TURRET = 105, CC = 100;

/** Structures an AI builds, in order; after the list it keeps power ahead of demand and adds turrets / depots. */
const BUILD_ORDER = [POWER_PLANT, DEPOT, BARRACKS, POWER_PLANT, FACTORY, TURRET, DEPOT, POWER_PLANT, TURRET, BARRACKS, TURRET, POWER_PLANT];

export interface AIState {
  player: number;
  /** Difficulty: scales how often it thinks and how big its attack waves are. */
  level: 'easy' | 'normal' | 'hard';
  built: number;
  lastWave: number;
}

export class AIPlayer {
  readonly state: AIState;
  constructor(player: number, level: AIState['level'] = 'normal') {
    this.state = { player, level, built: 0, lastWave: 0 };
  }

  private get thinkEvery(): number { return TICK_RATE * (this.state.level === 'easy' ? 4 : this.state.level === 'normal' ? 2.5 : 1.5); }
  private get waveSize(): number { return this.state.level === 'easy' ? 14 : this.state.level === 'normal' ? 10 : 7; }

  /** Called every sim tick (before `sim.step()`); acts every few seconds, staggered per player. */
  think(sim: Simulation): void {
    const p = this.state.player;
    if (sim.isDefeated(p)) return;
    if ((sim.tick + p * 7) % Math.round(this.thinkEvery) !== 0) return;
    const s = sim.store;

    // census
    let cc = -1, constructing = false, army = 0, wantPlants = 0;
    const completed: Record<number, number> = {};
    const idle: number[] = [];
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || s.owner[i] !== p) continue;
      if (isStructureType(s.type[i])) {
        if (!isComplete(s, i)) { if (s.type[i] !== TURRET) constructing = true; continue; }
        completed[s.type[i]] = (completed[s.type[i]] ?? 0) + 1;
        if (s.type[i] === CC && cc < 0) cc = i;
      } else if (UNIT_BY_ID.get(s.type[i])!.dps > 0) {
        army++;
        if (s.state[i] === STATE_IDLE && !s.engaged[i]) idle.push(s.idAt(i));
      }
    }
    if (cc < 0) return;

    // --- build structures (one at a time, like the sidebar) ---
    if (!constructing) {
      let type = BUILD_ORDER[this.state.built % BUILD_ORDER.length];
      // keep power ahead of demand
      if (sim.consumed[p] + 3 > sim.produced[p]) { type = POWER_PLANT; wantPlants = 1; }
      const def = STRUCTURE_BY_ID.get(type)!;
      if (sim.credits[p] >= def.cost && def.requires.every((r) => completed[r])) {
        const rng = simRng(sim.seed, SIM_STREAM.ai, sim.tick, p);
        for (let tries = 0; tries < 40; tries++) {
          const ang = rng() * Math.PI * 2;
          const r = 22 + rng() * (type === TURRET ? 55 : 42);
          const x = s.x[cc] + Math.cos(ang) * r, z = s.z[cc] + Math.sin(ang) * r;
          if (r > BUILD_RADIUS) continue;
          if (checkPlacement(s, sim.world, p, type, x, z, sim.credits[p]) !== 0) continue;
          // face roughly away from the base centre
          sim.submit({ kind: 'placeStructure', player: p, type, x, z, yaw: Math.atan2(x - s.x[cc], z - s.z[cc]), instant: 0 });
          if (!wantPlants) this.state.built++;
          break;
        }
      }
    }

    // --- production ---
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || s.owner[i] !== p || !isStructureType(s.type[i]) || !isComplete(s, i)) continue;
      const prod = sim.production.get(s.idAt(i));
      if (prod && prod.queue.length >= 1) continue;
      const t = s.type[i];
      if (t === BARRACKS) sim.submit({ kind: 'queueProduction', player: p, structure: s.idAt(i), unitType: this.state.built % 3 === 0 ? 2 : 1 });
      else if (t === FACTORY) sim.submit({ kind: 'queueProduction', player: p, structure: s.idAt(i), unitType: 4 });
    }

    // --- attack waves: send idle army to the nearest enemy structure ---
    if (army >= this.waveSize && idle.length >= this.waveSize * 0.6 && sim.tick - this.state.lastWave > TICK_RATE * 12) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < s.highWater; i++) {
        if (!s.alive[i] || s.owner[i] === p || !isStructureType(s.type[i]) || sim.isDefeated(s.owner[i])) continue;
        const d = Math.hypot(s.x[i] - s.x[cc], s.z[i] - s.z[cc]) + (s.owner[i] === 0 ? 0 : 150); // lean towards the human
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        sim.submit({ kind: 'move', player: p, ids: idle, x: s.x[best], z: s.z[best] });
        this.state.lastWave = sim.tick;
      }
    }
  }
}
