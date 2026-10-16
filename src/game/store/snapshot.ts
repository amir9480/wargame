// Full-state binary snapshots (checkpoints / save games / reconnect). Layout: header + JSON extras (economy, production)
// + free list + every store array up to the high-water mark. Versioned so saves can be migrated.
import { EntityStore } from './entities.ts';

export const SNAPSHOT_VERSION = 3;

/** Per-structure production state (head of queue + waiting unit types). */
export interface ProductionState { unit: number; base: number; rate: number; tick: number; queue: number[] }

/** A moving unit's route: flat world waypoints [x0, z0, x1, z1...], index of the one it walks to, its final goal, and the nav epoch it was checked at. */
export interface PathState { pts: number[]; i: number; gx: number; gz: number; epoch: number }

export interface SnapshotExtra {
  powerFactor: number[];
  produced: number[];
  consumed: number[];
  credits: number[];
  defeated: number[];
  /** structure id -> production state */
  production: Array<[number, ProductionState]>;
  /** entity id -> route (sim-only; replicas ignore it) */
  paths: Array<[number, PathState]>;
  /** Fractional credit income carried between ticks. */
  incomeAcc: number[];
}

export interface SnapshotMeta { tick: number; seed: number; extra: SnapshotExtra }

type TA = Uint8Array | Uint16Array | Uint32Array | Float32Array;

function arrays(s: EntityStore): TA[] {
  return [s.alive, s.gen, s.type, s.owner, s.state, s.x, s.y, s.z, s.yaw, s.vx, s.vz, s.pBase, s.pRate, s.pTick, s.hp, s.tx, s.tz, s.cool, s.engaged];
}

export function serializeStore(s: EntityStore, meta: SnapshotMeta): Uint8Array {
  const n = s.highWater;
  const free = s.getFreeList();
  const json = new TextEncoder().encode(JSON.stringify(meta.extra));
  let size = 4 * 7 + json.length + free.length * 4;
  for (const a of arrays(s)) size += n * a.BYTES_PER_ELEMENT;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint32(p, SNAPSHOT_VERSION, true); p += 4;
  dv.setUint32(p, meta.tick, true); p += 4;
  dv.setUint32(p, meta.seed, true); p += 4;
  dv.setUint32(p, n, true); p += 4;
  dv.setUint32(p, s.count, true); p += 4;
  dv.setUint32(p, json.length, true); p += 4;
  out.set(json, p); p += json.length;
  dv.setUint32(p, free.length, true); p += 4;
  for (const f of free) { dv.setUint32(p, f, true); p += 4; }
  for (const a of arrays(s)) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, n * a.BYTES_PER_ELEMENT);
    out.set(bytes, p); p += bytes.length;
  }
  return out;
}

export function restoreStore(bytes: Uint8Array, cap?: number): { store: EntityStore; meta: SnapshotMeta } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const version = dv.getUint32(p, true); p += 4;
  if (version !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot version ${version}`);
  const tick = dv.getUint32(p, true); p += 4;
  const seed = dv.getUint32(p, true); p += 4;
  const n = dv.getUint32(p, true); p += 4;
  p += 4; // count (recomputed)
  const jl = dv.getUint32(p, true); p += 4;
  const extra = JSON.parse(new TextDecoder().decode(bytes.subarray(p, p + jl))) as SnapshotExtra; p += jl;
  const nf = dv.getUint32(p, true); p += 4;
  const free: number[] = [];
  for (let i = 0; i < nf; i++) { free.push(dv.getUint32(p, true)); p += 4; }
  const store = new EntityStore(cap);
  for (const a of arrays(store)) {
    const len = n * a.BYTES_PER_ELEMENT;
    new Uint8Array(a.buffer, a.byteOffset, len).set(bytes.subarray(p, p + len)); p += len;
  }
  store.highWater = n;
  let live = 0;
  for (let i = 0; i < n; i++) if (store.alive[i]) live++;
  store.count = live;
  store.setFreeList(free);
  return { store, meta: { tick, seed, extra } };
}
