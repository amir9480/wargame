// Authoritative simulation: fixed-tick, command-driven, emits events + differential transforms.
// Pure TS (no Three.js); deterministic given (seed, command log). Jolt/nav hook in via `World`.
import { simRng, SIM_STREAM } from '../seeds.ts';
import { CHECKPOINT_EVERY, EVENT_HISTORY_TICKS, HASH_EVERY, MAX_PLAYERS, SNAPSHOT_EVERY, TICK_DT, TICK_RATE } from '../tuning.ts';
import { STRUCTURE_BY_ID, isStructureType } from '../defs/structures.ts';
import { UNIT_BY_ID, UNIT_SCALE } from '../defs/units.ts';
import { EntityStore, entityIndex } from '../store/entities.ts';
import { restoreStore, serializeStore, type PathState, type ProductionState, type SnapshotExtra } from '../store/snapshot.ts';
import type { Mover } from '../nav/navgrid.ts';
import { checkPlacement, FLAT_WORLD, isComplete, type World } from './placement.ts';
import { REJECT, type Command, type GameEvent, type TransformBatch, type TransformEntry } from './messages.ts';

export { FLAT_WORLD };
export type { World };

export interface TickOutput {
  tick: number;
  events: GameEvent[];
  transforms: TransformBatch | null;
}

export interface Checkpoint { tick: number; bytes: Uint8Array }

export const STATE_IDLE = 0;
export const STATE_MOVING = 1;
const MIN_POWER_FACTOR = 0.25;
const MAX_QUEUE = 5;
const START_CREDITS = 6000;
const SELL_REFUND = 0.5;
const RELOAD_TICKS = 10;
/** Share of a destroyed enemy's cost paid to the player that killed it. */
const BOUNTY_UNIT = 0.4;
const BOUNTY_STRUCTURE = 0.25;
const GRID_CELL = 32;
const GRID_BUCKETS = 8192;

export class Simulation {
  tick = 0;
  store: EntityStore;
  readonly seed: number;
  readonly world: World;
  readonly powerFactor: number[] = new Array(MAX_PLAYERS).fill(1);
  readonly produced: number[] = new Array(MAX_PLAYERS).fill(0);
  readonly consumed: number[] = new Array(MAX_PLAYERS).fill(0);
  readonly credits: number[] = new Array(MAX_PLAYERS).fill(START_CREDITS);
  readonly defeated: number[] = [];
  readonly production = new Map<number, ProductionState>();
  /** Routes of moving units (A* over the nav grid); empty without a nav grid (units then move in straight lines). */
  readonly paths = new Map<number, PathState>();
  private navEpochSeen = -1;
  private incomeAcc: number[] = new Array(MAX_PLAYERS).fill(0);
  private creditsDirty = new Set<number>();
  private powerDirty = true;
  private pending: Command[] = [];
  private history: Array<{ tick: number; events: GameEvent[] }> = [];
  checkpoint: Checkpoint | null = null;
  // spatial hash for combat (rebuilt every tick; not part of state)
  private gridHead = new Int32Array(GRID_BUCKETS);
  private gridNext: Int32Array;

  constructor(seed: number, world: World = FLAT_WORLD) {
    this.seed = seed;
    this.world = world;
    this.store = new EntityStore();
    this.gridNext = new Int32Array(this.store.cap);
    world.nav?.clearDynamic(); // a nav grid shared between games must not keep the previous game's structure footprints
  }

  /** Queue a client/AI command; it is validated and applied at the start of the next tick. */
  submit(cmd: Command): void {
    this.pending.push(cmd);
  }

  isDefeated(player: number): boolean {
    return this.defeated.includes(player);
  }

  step(): TickOutput {
    this.tick++;
    const events: GameEvent[] = [];
    const cmds = this.pending;
    this.pending = [];
    for (const c of cmds) this.apply(c, events);
    if (this.powerDirty) this.recomputePower(events);
    this.revalidatePaths(events);
    this.constructionSystem(events);
    this.productionSystem(events);
    if (this.tick % 10 === 0) this.incomeSystem();
    this.combatSystem(events);
    this.moveSystem();
    this.separationSystem();
    for (const p of this.creditsDirty) events.push({ kind: 'creditsChanged', tick: this.tick, player: p, credits: Math.floor(this.credits[p]) });
    this.creditsDirty.clear();

    let transforms: TransformBatch | null = null;
    if (this.tick % SNAPSHOT_EVERY === 0) transforms = this.collectTransforms();
    if (this.tick % HASH_EVERY === 0) events.push({ kind: 'stateHash', tick: this.tick, hash: this.store.hash() });

    if (events.length) this.history.push({ tick: this.tick, events });
    const minTick = this.tick - EVENT_HISTORY_TICKS;
    while (this.history.length && this.history[0].tick < minTick) this.history.shift();
    if (this.tick % CHECKPOINT_EVERY === 0) this.checkpoint = this.snapshot();
    return { tick: this.tick, events, transforms };
  }

  // ---- commands -----------------------------------------------------------------------------------------------
  private reject(player: number, reason: number, out: GameEvent[]): void {
    out.push({ kind: 'commandRejected', tick: this.tick, player, reason });
  }

  private spend(player: number, amount: number): void {
    this.credits[player] -= amount;
    this.creditsDirty.add(player);
  }

  private apply(c: Command, out: GameEvent[]): void {
    const s = this.store;
    if (c.player >= MAX_PLAYERS || (c.kind !== 'spawnUnits' && c.kind !== 'setPower' && this.isDefeated(c.player))) return;
    switch (c.kind) {
      case 'spawnUnits': {
        const def = UNIT_BY_ID.get(c.type);
        if (!def) return;
        const rng = simRng(this.seed, SIM_STREAM.spawn, this.tick, c.player);
        const side = Math.ceil(Math.sqrt(c.count));
        for (let k = 0; k < c.count; k++) {
          const x = c.x + ((k % side) - side / 2) * 2 + (rng() - 0.5) * 0.4;
          const z = c.z + (Math.floor(k / side) - side / 2) * 2 + (rng() - 0.5) * 0.4;
          this.spawnUnit(c.player, c.type, x, z, rng() * Math.PI * 2, out);
        }
        break;
      }
      case 'move': {
        const live = c.ids.filter((id) => s.isValid(id) && s.owner[entityIndex(id)] === c.player && !isStructureType(s.type[entityIndex(id)]));
        this.planMove(live.map(entityIndex), c.x, c.z, c.player, out);
        break;
      }
      case 'placeStructure': {
        const def = STRUCTURE_BY_ID.get(c.type);
        if (!def) return;
        if (!c.instant) {
          const why = checkPlacement(s, this.world, c.player, c.type, c.x, c.z, this.credits[c.player]);
          if (why) { this.reject(c.player, why, out); return; }
          this.spend(c.player, def.cost);
        }
        const id = s.spawn();
        const i = entityIndex(id);
        s.type[i] = c.type; s.owner[i] = c.player;
        s.x[i] = c.x; s.z[i] = c.z; s.y[i] = this.world.heightAt(c.x, c.z); s.yaw[i] = c.yaw;
        s.hp[i] = def.hp;
        if (c.instant) s.setProgress(i, this.tick, 1, 0);
        else s.setProgress(i, this.tick, 0, this.powerFactor[c.player] / def.buildTime);
        out.push(this.spawnedEvent(i));
        out.push({ kind: 'structureProgress', tick: this.tick, id, progress: s.pBase[i], rate: s.pRate[i] });
        this.world.nav?.addFootprint(c.x, c.z, def.width, def.depth, c.yaw); // units path around it from now on
        if (c.instant) this.powerDirty = true;
        break;
      }
      case 'setPower': {
        // Debug / test override of one player's power numbers (the sim recomputes them from structures when they change).
        this.setPowerNumbers(c.player, c.produced, c.consumed, out);
        break;
      }
      case 'queueProduction': {
        if (!s.isValid(c.structure)) return;
        const si = entityIndex(c.structure);
        const udef = UNIT_BY_ID.get(c.unitType);
        if (!udef || s.owner[si] !== c.player || s.type[si] !== udef.producedBy || !isComplete(s, si)) { this.reject(c.player, REJECT.invalid, out); return; }
        const st = this.production.get(c.structure);
        if (st && st.queue.length >= MAX_QUEUE) { this.reject(c.player, REJECT.queueFull, out); return; }
        if (this.credits[c.player] < udef.cost) { this.reject(c.player, REJECT.credits, out); return; }
        this.spend(c.player, udef.cost);
        if (st) { st.queue.push(c.unitType); this.emitProduction(c.structure, st, out); }
        else this.startProduction(c.structure, c.unitType, [], out);
        break;
      }
      case 'cancelProduction': {
        const st = this.production.get(c.structure);
        if (!st || !s.isValid(c.structure) || s.owner[entityIndex(c.structure)] !== c.player) return;
        const refund = UNIT_BY_ID.get(st.queue.length ? st.queue[st.queue.length - 1] : st.unit)!.cost;
        this.credits[c.player] += refund; this.creditsDirty.add(c.player);
        if (st.queue.length) { st.queue.pop(); this.emitProduction(c.structure, st, out); }
        else { this.production.delete(c.structure); out.push({ kind: 'productionProgress', tick: this.tick, id: c.structure, unitType: 0, progress: 0, rate: 0, queued: 0 }); }
        break;
      }
      case 'sell': {
        if (!s.isValid(c.id)) return;
        const i = entityIndex(c.id);
        if (s.owner[i] !== c.player || !isStructureType(s.type[i])) return;
        this.credits[c.player] += STRUCTURE_BY_ID.get(s.type[i])!.cost * SELL_REFUND; this.creditsDirty.add(c.player);
        this.kill(i, out);
        break;
      }
    }
  }

  private spawnUnit(player: number, type: number, x: number, z: number, yaw: number, out: GameEvent[]): number {
    const s = this.store;
    const def = UNIT_BY_ID.get(type)!;
    const id = s.spawn();
    const i = entityIndex(id);
    s.type[i] = type; s.owner[i] = player;
    s.x[i] = x; s.z[i] = z; s.y[i] = this.world.heightAt(x, z); s.yaw[i] = yaw;
    s.hp[i] = def.hp;
    out.push(this.spawnedEvent(i));
    return i;
  }

  private spawnedEvent(i: number): GameEvent {
    const s = this.store;
    return { kind: 'entitySpawned', tick: this.tick, id: s.idAt(i), type: s.type[i], owner: s.owner[i], x: s.x[i], y: s.y[i], z: s.z[i], yaw: s.yaw[i], progress: s.pBase[i], hp: s.hp[i] };
  }

  // ---- power ----------------------------------------------------------------------------------------------------
  private recomputePower(out: GameEvent[]): void {
    this.powerDirty = false;
    const s = this.store;
    const prod = new Array(MAX_PLAYERS).fill(0), cons = new Array(MAX_PLAYERS).fill(0);
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || !isStructureType(s.type[i]) || !isComplete(s, i)) continue;
      const p = STRUCTURE_BY_ID.get(s.type[i])!.power;
      if (p > 0) prod[s.owner[i]] += p; else cons[s.owner[i]] -= p;
    }
    for (let p = 0; p < MAX_PLAYERS; p++) this.setPowerNumbers(p, prod[p], cons[p], out);
  }

  private setPowerNumbers(player: number, produced: number, consumed: number, out: GameEvent[]): void {
    const f = consumed <= 0 || produced >= consumed ? 1 : Math.max(MIN_POWER_FACTOR, produced / consumed);
    const changed = f !== this.powerFactor[player] || produced !== this.produced[player] || consumed !== this.consumed[player];
    if (!changed) return;
    const factorChanged = f !== this.powerFactor[player];
    this.powerFactor[player] = f; this.produced[player] = produced; this.consumed[player] = consumed;
    out.push({ kind: 'powerChanged', tick: this.tick, player, factor: f, produced, consumed });
    if (!factorChanged) return;
    const s = this.store;
    // Re-baseline everything progressing for this player at its current value with the new rate.
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || s.owner[i] !== player || !isStructureType(s.type[i]) || s.pRate[i] === 0) continue;
      const def = STRUCTURE_BY_ID.get(s.type[i])!;
      s.setProgress(i, this.tick, s.progressAt(i, this.tick), f / def.buildTime);
      out.push({ kind: 'structureProgress', tick: this.tick, id: s.idAt(i), progress: s.pBase[i], rate: s.pRate[i] });
    }
    for (const [sid, st] of this.production) {
      if (s.owner[entityIndex(sid)] !== player) continue;
      this.rebaseProduction(st);
      this.emitProduction(sid, st, out);
    }
  }

  // ---- systems ------------------------------------------------------------------------------------------------
  private constructionSystem(out: GameEvent[]): void {
    const s = this.store;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || !isStructureType(s.type[i]) || s.pRate[i] === 0) continue;
      if (s.progressAt(i, this.tick) >= 1) {
        s.setProgress(i, this.tick, 1, 0);
        out.push({ kind: 'structureProgress', tick: this.tick, id: s.idAt(i), progress: 65535, rate: 0 });
        out.push({ kind: 'structureCompleted', tick: this.tick, id: s.idAt(i) });
        this.powerDirty = true;
      }
    }
  }

  private unitProgress(st: ProductionState): number {
    const p = st.base / 65535 + (st.rate * (this.tick - st.tick)) / TICK_RATE;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  private rebaseProduction(st: ProductionState): void {
    // New baseline at the current value; `emitProduction` then sets the rate from the owner's power factor.
    st.base = Math.round(this.unitProgress(st) * 65535);
    st.tick = this.tick;
  }

  private startProduction(structure: number, unitType: number, queue: number[], out: GameEvent[]): void {
    const s = this.store;
    const udef = UNIT_BY_ID.get(unitType)!;
    const owner = s.owner[entityIndex(structure)];
    const st: ProductionState = { unit: unitType, base: 0, rate: this.powerFactor[owner] / udef.buildTime, tick: this.tick, queue };
    this.production.set(structure, st);
    this.emitProduction(structure, st, out);
  }

  private emitProduction(structure: number, st: ProductionState, out: GameEvent[]): void {
    const owner = this.store.owner[entityIndex(structure)];
    // Keep the rate consistent with the owner's current power factor.
    st.rate = this.powerFactor[owner] / UNIT_BY_ID.get(st.unit)!.buildTime;
    out.push({ kind: 'productionProgress', tick: this.tick, id: structure, unitType: st.unit, progress: st.base, rate: st.rate, queued: st.queue.length });
  }

  private productionSystem(out: GameEvent[]): void {
    if (!this.production.size) return;
    const s = this.store;
    for (const [sid, st] of [...this.production]) {
      if (!s.isValid(sid)) { this.production.delete(sid); continue; }
      if (this.unitProgress(st) < 1) continue;
      const si = entityIndex(sid);
      const sdef = STRUCTURE_BY_ID.get(s.type[si])!;
      const fx = Math.sin(s.yaw[si]), fz = Math.cos(s.yaw[si]);
      const off = sdef.depth / 2 + 4;
      const rng = simRng(this.seed, SIM_STREAM.spawn, this.tick, sid);
      const ui = this.spawnUnit(s.owner[si], st.unit, s.x[si] + fx * off + (rng() - 0.5) * 3, s.z[si] + fz * off + (rng() - 0.5) * 3, s.yaw[si], out);
      // Walk off to a rally point in front of the structure (routed like any other move).
      this.planMove([ui], s.x[si] + fx * (off + 10 + rng() * 6), s.z[si] + fz * (off + 10 + rng() * 6), s.owner[si], out);
      const next = st.queue.shift();
      if (next === undefined) {
        this.production.delete(sid);
        out.push({ kind: 'productionProgress', tick: this.tick, id: sid, unitType: 0, progress: 0, rate: 0, queued: 0 });
      } else {
        st.unit = next; st.base = 0; st.tick = this.tick;
        this.emitProduction(sid, st, out);
      }
    }
  }

  private incomeSystem(): void {
    const s = this.store;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || !isStructureType(s.type[i]) || !isComplete(s, i)) continue;
      const inc = STRUCTURE_BY_ID.get(s.type[i])!.income;
      if (inc <= 0) continue;
      const p = s.owner[i];
      this.incomeAcc[p] += inc * (10 / TICK_RATE);
    }
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const whole = Math.floor(this.incomeAcc[p]);
      if (whole > 0) { this.credits[p] += whole; this.incomeAcc[p] -= whole; this.creditsDirty.add(p); }
    }
  }

  private cell(v: number): number { return Math.floor(v / GRID_CELL); }
  private bucket(cx: number, cz: number): number { return (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & (GRID_BUCKETS - 1); }

  private combatSystem(out: GameEvent[]): void {
    const s = this.store;
    this.gridHead.fill(-1);
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i]) continue;
      const b = this.bucket(this.cell(s.x[i]), this.cell(s.z[i]));
      this.gridNext[i] = this.gridHead[b]; this.gridHead[b] = i;
    }
    const hurt = new Map<number, number>();
    const dead = new Map<number, number>(); // victim index -> killer's owner
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i]) continue;
      let range = 0, dps = 0;
      if (isStructureType(s.type[i])) {
        const d = STRUCTURE_BY_ID.get(s.type[i])!;
        if (d.dps <= 0 || !isComplete(s, i)) continue;
        range = d.range; dps = d.dps * this.powerFactor[s.owner[i]];
      } else {
        const d = UNIT_BY_ID.get(s.type[i])!;
        if (d.dps <= 0) continue; // units fire on the move (acts as attack-move)
        range = d.range; dps = d.dps;
      }
      if (s.cool[i] > 0) s.cool[i]--;
      // nearest enemy in range
      const cx0 = this.cell(s.x[i] - range), cx1 = this.cell(s.x[i] + range);
      const cz0 = this.cell(s.z[i] - range), cz1 = this.cell(s.z[i] + range);
      let best = -1, bestD = range * range;
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.gridHead[this.bucket(cx, cz)]; j >= 0; j = this.gridNext[j]) {
          if (s.owner[j] === s.owner[i] || (s.hp[j] === 0)) continue;
          const dx = s.x[j] - s.x[i], dz = s.z[j] - s.z[i];
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD || (d2 === bestD && best >= 0 && j < best)) { bestD = d2; best = j; }
        }
      }
      s.engaged[i] = best >= 0 ? 1 : 0;
      if (best < 0 || s.cool[i] > 0) continue;
      s.cool[i] = RELOAD_TICKS;
      s.yaw[i] = Math.atan2(s.x[best] - s.x[i], s.z[best] - s.z[i]);
      s.dirty[i] = 1;
      const dmg = Math.max(1, Math.round(dps * (RELOAD_TICKS / TICK_RATE)));
      const left = Math.max(0, s.hp[best] - dmg);
      s.hp[best] = left;
      hurt.set(best, left);
      out.push({ kind: 'fire', tick: this.tick, from: s.idAt(i), to: s.idAt(best) });
      if (left === 0 && !dead.has(best)) dead.set(best, s.owner[i]);
    }
    for (const [j, hp] of hurt) if (hp > 0) out.push({ kind: 'hpChanged', tick: this.tick, id: s.idAt(j), hp });
    for (const [j, killer] of dead) if (s.alive[j]) this.kill(j, out, killer);
  }

  /** Removes an entity (death or sell), and a player with no structures left is defeated. A killer is paid a bounty. */
  private kill(i: number, out: GameEvent[], killer = -1): void {
    const s = this.store;
    const id = s.idAt(i);
    const owner = s.owner[i];
    const wasStructure = isStructureType(s.type[i]);
    if (killer >= 0 && killer !== owner && !this.isDefeated(killer)) {
      const cost = wasStructure ? STRUCTURE_BY_ID.get(s.type[i])?.cost : UNIT_BY_ID.get(s.type[i])?.cost;
      if (cost) { this.credits[killer] += Math.round(cost * (wasStructure ? BOUNTY_STRUCTURE : BOUNTY_UNIT)); this.creditsDirty.add(killer); }
    }
    s.hp[i] = 0;
    this.paths.delete(id);
    if (wasStructure) this.dropFootprint(i);
    s.remove(id);
    out.push({ kind: 'entityRemoved', tick: this.tick, id });
    if (!wasStructure) return;
    this.production.delete(id);
    this.powerDirty = true;
    for (let k = 0; k < s.highWater; k++) if (s.alive[k] && s.owner[k] === owner && isStructureType(s.type[k])) return;
    this.defeat(owner, out);
  }

  private defeat(player: number, out: GameEvent[]): void {
    if (this.isDefeated(player)) return;
    this.defeated.push(player);
    const s = this.store;
    for (let k = 0; k < s.highWater; k++) {
      if (!s.alive[k] || s.owner[k] !== player) continue;
      const id = s.idAt(k);
      this.paths.delete(id);
      if (isStructureType(s.type[k])) this.dropFootprint(k);
      s.remove(id);
      out.push({ kind: 'entityRemoved', tick: this.tick, id });
    }
    out.push({ kind: 'playerDefeated', tick: this.tick, player });
  }

  // ---- routing -----------------------------------------------------------------------------------------------------
  private dropFootprint(i: number): void {
    const s = this.store;
    const def = STRUCTURE_BY_ID.get(s.type[i]);
    if (def) this.world.nav?.removeFootprint(s.x[i], s.z[i], def.width, def.depth, s.yaw[i]);
  }

  private startPath(i: number, pts: number[], gx: number, gz: number): void {
    const s = this.store;
    this.paths.set(s.idAt(i), { pts, i: 0, gx, gz, epoch: this.world.nav?.epoch ?? 0 });
    s.tx[i] = pts[0]; s.tz[i] = pts[1];
    s.state[i] = STATE_MOVING; s.dirty[i] = 1;
  }

  /**
   * Orders units (entity indices) to a point. Without a nav grid they walk straight; with one, each mover class gets ONE A* route
   * (from the unit nearest the group's centre) that the others join by line of sight, and each unit ends on its own formation spot.
   * A unit that can't see the shared route gets its own A*. An unreachable goal rejects the order (`noPath`).
   */
  private planMove(units: number[], x: number, z: number, player: number, out: GameEvent[]): void {
    const s = this.store;
    if (!units.length) return;
    const side = Math.ceil(Math.sqrt(units.length));
    const spot = (k: number): [number, number] => [x + ((k % side) - (side - 1) / 2) * 3, z + (Math.floor(k / side) - (side - 1) / 2) * 3];
    const nav = this.world.nav;
    if (!nav) {
      units.forEach((i, k) => {
        [s.tx[i], s.tz[i]] = spot(k);
        this.paths.delete(s.idAt(i));
        s.state[i] = STATE_MOVING; s.dirty[i] = 1;
      });
      return;
    }
    const groups = new Map<Mover, number[]>();
    units.forEach((_, k) => {
      const m = UNIT_BY_ID.get(s.type[units[k]])?.mover;
      if (!m) return;
      const g = groups.get(m);
      if (g) g.push(k); else groups.set(m, [k]);
    });
    let rejected = false;
    for (const [m, ks] of groups) {
      let cx = 0, cz = 0;
      for (const k of ks) { cx += s.x[units[k]]; cz += s.z[units[k]]; }
      cx /= ks.length; cz /= ks.length;
      let leader = units[ks[0]], bestD = Infinity;
      for (const k of ks) {
        const d = Math.hypot(s.x[units[k]] - cx, s.z[units[k]] - cz);
        if (d < bestD) { bestD = d; leader = units[k]; }
      }
      const route = nav.findPath(m, s.x[leader], s.z[leader], x, z);
      if (!route) { rejected = true; continue; }
      for (const k of ks) {
        const i = units[k];
        const [tx, tz] = spot(k);
        const pts = this.joinRoute(nav, m, i, route, tx, tz);
        if (pts) this.startPath(i, pts, tx, tz); else rejected = true;
      }
    }
    if (rejected) this.reject(player, REJECT.noPath, out);
  }

  /** A unit's own waypoints: join the shared route at its farthest visible waypoint, finish on its formation spot. */
  private joinRoute(nav: NonNullable<World['nav']>, m: Mover, i: number, route: number[], tx: number, tz: number): number[] | null {
    const s = this.store;
    let j = -1;
    for (let k = route.length / 2 - 1; k >= 0; k--) {
      if (nav.los(m, s.x[i], s.z[i], route[2 * k], route[2 * k + 1])) { j = k; break; }
    }
    if (j < 0) return nav.findPath(m, s.x[i], s.z[i], tx, tz);
    const pts = route.slice(2 * j);
    const lx = pts[pts.length - 2], lz = pts[pts.length - 1];
    if (Math.hypot(tx - lx, tz - lz) > 0.5 && nav.passable(m, nav.idx(nav.cellOf(tx), nav.cellOf(tz))) && nav.los(m, lx, lz, tx, tz)) pts.push(tx, tz);
    return pts;
  }

  /** After structures appeared / vanished: any route whose next stretch is now blocked is planned again to its goal. */
  private revalidatePaths(out: GameEvent[]): void {
    const nav = this.world.nav;
    if (!nav || nav.epoch === this.navEpochSeen) return;
    this.navEpochSeen = nav.epoch;
    const s = this.store;
    for (const [id, p] of [...this.paths]) {
      if (p.epoch === nav.epoch) continue;
      p.epoch = nav.epoch;
      if (!s.isValid(id)) { this.paths.delete(id); continue; }
      const i = entityIndex(id);
      const m = UNIT_BY_ID.get(s.type[i])?.mover;
      if (!m) continue;
      let px = s.x[i], pz = s.z[i], blocked = false;
      for (let k = p.i; k < Math.min(p.pts.length / 2, p.i + 4) && !blocked; k++) {
        const wx = p.pts[2 * k], wz = p.pts[2 * k + 1];
        blocked = !nav.los(m, px, pz, wx, wz);
        px = wx; pz = wz;
      }
      if (blocked) this.planMove([i], p.gx, p.gz, s.owner[i], out);
    }
  }

  private moveSystem(): void {
    const s = this.store;
    const nav = this.world.nav;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || s.state[i] !== STATE_MOVING) continue;
      const def = UNIT_BY_ID.get(s.type[i]);
      if (!def) continue;
      if (s.engaged[i]) { // an enemy is in range: stand and fight, the order (and its route) resumes afterwards
        if (s.vx[i] !== 0 || s.vz[i] !== 0) { s.vx[i] = 0; s.vz[i] = 0; s.dirty[i] = 1; }
        continue;
      }
      const speed = def.speed * (nav ? nav.speedFactor(def.mover, s.x[i], s.z[i]) : 1);
      const step = speed * TICK_DT;
      const dx = s.tx[i] - s.x[i], dz = s.tz[i] - s.z[i];
      const dist = Math.hypot(dx, dz);
      if (dist <= step) {
        s.x[i] = s.tx[i]; s.z[i] = s.tz[i];
        const id = s.idAt(i);
        const p = this.paths.get(id);
        if (p && (p.i + 1) * 2 < p.pts.length) {
          p.i++; // on to the next waypoint
          s.tx[i] = p.pts[2 * p.i]; s.tz[i] = p.pts[2 * p.i + 1];
        } else {
          s.vx[i] = 0; s.vz[i] = 0; s.state[i] = STATE_IDLE;
          this.paths.delete(id);
        }
      } else {
        s.vx[i] = (dx / dist) * speed; s.vz[i] = (dz / dist) * speed;
        s.x[i] += s.vx[i] * TICK_DT; s.z[i] += s.vz[i] * TICK_DT;
        s.yaw[i] = Math.atan2(dx, dz);
      }
      s.y[i] = this.world.heightAt(s.x[i], s.z[i]);
      s.dirty[i] = 1;
    }
  }

  /**
   * Units never overlap each other or a structure: each unit is pushed out of any unit it touches (half the overlap each, softened)
   * and out of structure footprints. Uses the spatial grid built by the combat system this tick. A push into terrain the unit
   * can't stand on (nav) is skipped.
   */
  private separationSystem(): void {
    const s = this.store;
    const nav = this.world.nav;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || isStructureType(s.type[i])) continue;
      const def = UNIT_BY_ID.get(s.type[i]);
      if (!def) continue;
      const ri = def.radius * UNIT_SCALE;
      let px = 0, pz = 0;
      const cx = this.cell(s.x[i]), cz = this.cell(s.z[i]);
      for (let gz = cz - 1; gz <= cz + 1; gz++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let j = this.gridHead[this.bucket(gx, gz)]; j >= 0; j = this.gridNext[j]) {
          if (j === i || !s.alive[j]) continue;
          if (isStructureType(s.type[j])) {
            const sd = STRUCTURE_BY_ID.get(s.type[j])!;
            const sn = Math.sin(s.yaw[j]), cs = Math.cos(s.yaw[j]);
            const dx = s.x[i] - s.x[j], dz = s.z[i] - s.z[j];
            const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; // into the structure's frame
            const ox = sd.width / 2 + ri - Math.abs(lx), oz = sd.depth / 2 + ri - Math.abs(lz);
            if (ox <= 0 || oz <= 0) continue;
            // leave through the nearest face
            let wx = 0, wz = 0;
            if (ox < oz) wx = (lx >= 0 ? 1 : -1) * ox; else wz = (lz >= 0 ? 1 : -1) * oz;
            px += wx * cs + wz * sn; pz += -wx * sn + wz * cs;
            continue;
          }
          const dj = UNIT_BY_ID.get(s.type[j]);
          if (!dj) continue;
          const reach = ri + dj.radius * UNIT_SCALE;
          let dx = s.x[i] - s.x[j], dz = s.z[i] - s.z[j];
          const d2 = dx * dx + dz * dz;
          if (d2 >= reach * reach) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-4) { const a = ((i * 2654435761 + j) >>> 0) / 4294967296 * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); d = 1; }
          const push = (reach - d) * 0.5 * 0.6;
          px += (dx / d) * push; pz += (dz / d) * push;
        }
      }
      if (px === 0 && pz === 0) continue;
      const len = Math.hypot(px, pz);
      if (len > 1.5) { px = (px / len) * 1.5; pz = (pz / len) * 1.5; } // never teleport
      const nx = s.x[i] + px, nz = s.z[i] + pz;
      if (nav) { // terrain only (structure margins are blocked on purpose, a unit inside one must be able to leave)
        const c = nav.idx(nav.cellOf(nx), nav.cellOf(nz));
        if (c < 0 || nav.cost[def.mover][c] === 0) continue;
      }
      s.x[i] = nx; s.z[i] = nz;
      s.y[i] = this.world.heightAt(nx, nz);
      s.dirty[i] = 1;
    }
  }

  private collectTransforms(): TransformBatch {
    const s = this.store;
    const entries: TransformEntry[] = [];
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || !s.dirty[i]) continue;
      s.dirty[i] = 0;
      entries.push({ id: s.idAt(i), x: s.x[i], y: s.y[i], z: s.z[i], yaw: s.yaw[i], vx: s.vx[i], vz: s.vz[i], state: s.state[i] });
    }
    return { tick: this.tick, entries };
  }

  // ---- save / reconnect ---------------------------------------------------------------------------------------
  private extra(): SnapshotExtra {
    return {
      powerFactor: this.powerFactor.slice(), produced: this.produced.slice(), consumed: this.consumed.slice(),
      credits: this.credits.slice(), defeated: this.defeated.slice(), incomeAcc: this.incomeAcc.slice(),
      production: [...this.production].map(([id, st]) => [id, { ...st, queue: st.queue.slice() }]),
      paths: [...this.paths].map(([id, p]) => [id, { ...p, pts: p.pts.slice() }]),
    };
  }

  /** Full-state snapshot at the current tick (checkpoint, save game, or reconnect sync). */
  snapshot(): Checkpoint {
    return { tick: this.tick, bytes: serializeStore(this.store, { tick: this.tick, seed: this.seed, extra: this.extra() }) };
  }

  static fromSnapshot(bytes: Uint8Array, world: World = FLAT_WORLD): Simulation {
    const { store, meta } = restoreStore(bytes);
    const sim = new Simulation(meta.seed, world);
    sim.store = store;
    sim.tick = meta.tick;
    const e = meta.extra;
    e.powerFactor.forEach((f, i) => { sim.powerFactor[i] = f; });
    e.produced.forEach((f, i) => { sim.produced[i] = f; });
    e.consumed.forEach((f, i) => { sim.consumed[i] = f; });
    e.credits.forEach((f, i) => { sim.credits[i] = f; });
    e.incomeAcc.forEach((f, i) => { sim.incomeAcc[i] = f; });
    sim.defeated.push(...e.defeated);
    for (const [id, st] of e.production) sim.production.set(id, st);
    // Structure footprints are dynamic nav obstacles: rebuild them from the restored entities, then adopt the saved routes.
    const nav = world.nav;
    if (nav) {
      for (let i = 0; i < store.highWater; i++) {
        if (!store.alive[i] || !isStructureType(store.type[i])) continue;
        const d = STRUCTURE_BY_ID.get(store.type[i]);
        if (d) nav.addFootprint(store.x[i], store.z[i], d.width, d.depth, store.yaw[i]);
      }
    }
    for (const [id, p] of e.paths ?? []) sim.paths.set(id, { ...p, epoch: nav?.epoch ?? 0 });
    sim.powerDirty = false;
    return sim;
  }

  /** Events with tick > lastTick, or null if the history no longer reaches back that far (client needs a snapshot). */
  eventsSince(lastTick: number): GameEvent[] | null {
    if (lastTick < this.tick - EVENT_HISTORY_TICKS) return null;
    const out: GameEvent[] = [];
    for (const h of this.history) if (h.tick > lastTick) out.push(...h.events);
    return out;
  }
}
