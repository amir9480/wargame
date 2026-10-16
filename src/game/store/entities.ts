// Struct-of-arrays entity store, shared by the authoritative sim and client replicas.
// Entity id = (generation << 16) | index. Replicated fields are the ones hashed / snapshotted; sim-only fields
// (move targets) are saved in checkpoints but excluded from the replica hash.
import { MAX_ENTITIES, TICK_RATE } from '../tuning.ts';

export const NO_ENTITY = 0xffffffff;

export function entityIndex(id: number): number { return id & 0xffff; }
export function entityGen(id: number): number { return id >>> 16; }

export class EntityStore {
  readonly cap: number;
  // replicated
  readonly alive: Uint8Array;
  readonly gen: Uint16Array;
  readonly type: Uint16Array;
  readonly owner: Uint8Array;
  readonly state: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  /** Synced 0..1 value (u16): baseline at `pTick`, advancing at `pRate` per second. */
  readonly pBase: Uint16Array;
  readonly pRate: Float32Array;
  readonly pTick: Uint32Array;
  /** Hit points (replicated through spawn / hpChanged events). */
  readonly hp: Uint16Array;
  // sim-only
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly dirty: Uint8Array;
  /** Ticks until the weapon can fire again. */
  readonly cool: Uint8Array;
  /** 1 while the unit has an enemy in range (AI leaves engaged units alone). */
  readonly engaged: Uint8Array;

  highWater = 0;
  count = 0;
  private free: number[] = [];

  constructor(cap = MAX_ENTITIES) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.gen = new Uint16Array(cap);
    this.type = new Uint16Array(cap);
    this.owner = new Uint8Array(cap);
    this.state = new Uint8Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.yaw = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.pBase = new Uint16Array(cap);
    this.pRate = new Float32Array(cap);
    this.pTick = new Uint32Array(cap);
    this.hp = new Uint16Array(cap);
    this.tx = new Float32Array(cap);
    this.tz = new Float32Array(cap);
    this.dirty = new Uint8Array(cap);
    this.cool = new Uint8Array(cap);
    this.engaged = new Uint8Array(cap);
  }

  /** Allocate a slot (sim). Returns the entity id. */
  spawn(): number {
    let i: number;
    if (this.free.length) i = this.free.pop()!;
    else {
      if (this.highWater >= this.cap) throw new Error('entity store full');
      i = this.highWater++;
    }
    return this.claim(i, this.gen[i]);
  }

  /** Allocate a specific id (replica applying a spawn event, or checkpoint restore). */
  spawnAt(id: number): void {
    const i = entityIndex(id);
    if (i >= this.highWater) { for (let k = this.highWater; k < i; k++) this.free.push(k); this.highWater = i + 1; }
    else if (!this.alive[i]) { const f = this.free.indexOf(i); if (f >= 0) this.free.splice(f, 1); }
    this.claim(i, entityGen(id));
  }

  private claim(i: number, gen: number): number {
    this.alive[i] = 1;
    this.gen[i] = gen;
    this.type[i] = 0; this.owner[i] = 0; this.state[i] = 0;
    this.x[i] = this.y[i] = this.z[i] = this.yaw[i] = this.vx[i] = this.vz[i] = 0;
    this.pBase[i] = 65535; this.pRate[i] = 0; this.pTick[i] = 0;
    this.tx[i] = this.tz[i] = 0;
    this.hp[i] = 1; this.cool[i] = 0; this.engaged[i] = 0;
    this.dirty[i] = 1;
    this.count++;
    return ((gen << 16) | i) >>> 0;
  }

  remove(id: number): void {
    const i = entityIndex(id);
    if (!this.isValid(id)) return;
    this.alive[i] = 0;
    this.gen[i] = (this.gen[i] + 1) & 0xffff;
    this.free.push(i);
    this.count--;
  }

  isValid(id: number): boolean {
    const i = entityIndex(id);
    return i < this.highWater && this.alive[i] === 1 && this.gen[i] === entityGen(id);
  }

  /** Free-slot stack in allocation order; saved verbatim so ids allocated after a restore match an uninterrupted run. */
  getFreeList(): readonly number[] { return this.free; }
  setFreeList(list: number[]): void { this.free = list.slice(); }

  idAt(i: number): number { return ((this.gen[i] << 16) | i) >>> 0; }

  /** Synced 0..1 value at a given tick (identical formula on sim and replicas). */
  progressAt(i: number, tick: number): number {
    const p = this.pBase[i] / 65535 + (this.pRate[i] * (tick - this.pTick[i])) / TICK_RATE;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /** Re-baseline the synced value at `tick`. */
  setProgress(i: number, tick: number, progress01: number, ratePerSec: number): void {
    this.pBase[i] = Math.round(Math.min(1, Math.max(0, progress01)) * 65535);
    this.pRate[i] = ratePerSec;
    this.pTick[i] = tick;
  }

  /** FNV-1a over the replicated fields of all live entities. `tick` resolves the synced 0..1 value. */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => { h = Math.imul(h ^ (v >>> 0), 0x01000193) >>> 0; };
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    const mixF = (v: number) => { f[0] = v; mix(u[0]); };
    for (let i = 0; i < this.highWater; i++) {
      if (!this.alive[i]) continue;
      mix(this.idAt(i)); mix(this.type[i]); mix(this.owner[i]); mix(this.state[i]);
      mixF(this.x[i]); mixF(this.y[i]); mixF(this.z[i]); mixF(this.yaw[i]); mixF(this.vx[i]); mixF(this.vz[i]);
      mix(this.pBase[i]); mixF(this.pRate[i]); mix(this.pTick[i]); mix(this.hp[i]);
    }
    return h >>> 0;
  }
}
