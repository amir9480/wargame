// Client-side replica. Built ONLY from events + transforms + snapshots; the renderer/HUD read this, never the sim.
import { MAX_PLAYERS } from '../tuning.ts';
import { EntityStore, entityIndex } from '../store/entities.ts';
import { restoreStore, type ProductionState } from '../store/snapshot.ts';
import type { GameEvent, TransformBatch } from '../sim/messages.ts';

export interface ReplicaProduction { unit: number; base: number; rate: number; tick: number; queued: number }

export interface ShotFx { from: number; to: number; tick: number }

export class ClientState {
  store = new EntityStore();
  tick = 0;
  readonly powerFactor: number[] = new Array(MAX_PLAYERS).fill(1);
  readonly produced: number[] = new Array(MAX_PLAYERS).fill(0);
  readonly consumed: number[] = new Array(MAX_PLAYERS).fill(0);
  readonly credits: number[] = new Array(MAX_PLAYERS).fill(0);
  readonly defeated: number[] = [];
  /** Structure id -> head-of-queue production (synced 0..1 value + waiting count). */
  readonly production = new Map<number, ReplicaProduction>();
  /** Set when a stateHash event disagrees with the replica (dev desync detector). */
  desyncAt = -1;
  /** Transient events for the presentation layer; drained by the consumer each frame. */
  shots: ShotFx[] = [];
  rejections: Array<{ player: number; reason: number }> = [];
  removed: number[] = [];
  completed: number[] = [];
  private pendingHash: Array<{ tick: number; hash: number }> = [];

  /** Replace the whole replica from a checkpoint (initial join, refresh, load game). */
  restore(bytes: Uint8Array): void {
    const { store, meta } = restoreStore(bytes);
    this.store = store;
    this.tick = meta.tick;
    const e = meta.extra;
    e.powerFactor.forEach((f, i) => { this.powerFactor[i] = f; });
    e.produced.forEach((f, i) => { this.produced[i] = f; });
    e.consumed.forEach((f, i) => { this.consumed[i] = f; });
    e.credits.forEach((f, i) => { this.credits[i] = Math.floor(f); });
    this.defeated.length = 0; this.defeated.push(...e.defeated);
    this.production.clear();
    for (const [id, st] of e.production as Array<[number, ProductionState]>) {
      this.production.set(id, { unit: st.unit, base: st.base, rate: st.rate, tick: st.tick, queued: st.queue.length });
    }
  }

  /** Synced 0..1 value of a structure under construction, at the replica's tick (+ `extraSeconds` of render time). */
  structureProgress(i: number, extraSeconds = 0): number {
    const s = this.store;
    const p = s.pBase[i] / 65535 + s.pRate[i] * ((this.tick - s.pTick[i]) / 20 + extraSeconds);
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  productionProgress(p: ReplicaProduction, extraSeconds = 0): number {
    const v = p.base / 65535 + p.rate * ((this.tick - p.tick) / 20 + extraSeconds);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  applyEvents(list: GameEvent[]): void {
    const s = this.store;
    for (const e of list) {
      switch (e.kind) {
        case 'entitySpawned': {
          s.spawnAt(e.id);
          const i = entityIndex(e.id);
          s.type[i] = e.type; s.owner[i] = e.owner;
          s.x[i] = e.x; s.y[i] = e.y; s.z[i] = e.z; s.yaw[i] = e.yaw;
          s.pBase[i] = e.progress; s.pRate[i] = 0; s.pTick[i] = 0; // baseline/rate arrive via structureProgress
          s.hp[i] = e.hp;
          break;
        }
        case 'entityRemoved': {
          s.remove(e.id);
          this.production.delete(e.id);
          this.removed.push(e.id);
          break;
        }
        case 'structureProgress': {
          if (!s.isValid(e.id)) break;
          const i = entityIndex(e.id);
          s.pBase[i] = e.progress; s.pRate[i] = e.rate; s.pTick[i] = e.tick;
          break;
        }
        case 'structureCompleted': this.completed.push(e.id); break;
        case 'powerChanged':
          this.powerFactor[e.player] = e.factor; this.produced[e.player] = e.produced; this.consumed[e.player] = e.consumed;
          break;
        case 'hpChanged': if (s.isValid(e.id)) s.hp[entityIndex(e.id)] = e.hp; break;
        case 'creditsChanged': this.credits[e.player] = e.credits; break;
        case 'productionProgress':
          if (e.unitType === 0) this.production.delete(e.id);
          else this.production.set(e.id, { unit: e.unitType, base: e.progress, rate: e.rate, tick: e.tick, queued: e.queued });
          break;
        case 'fire': this.shots.push({ from: e.from, to: e.to, tick: e.tick }); break;
        case 'commandRejected': this.rejections.push({ player: e.player, reason: e.reason }); break;
        case 'playerDefeated': if (!this.defeated.includes(e.player)) this.defeated.push(e.player); break;
        case 'stateHash': this.pendingHash.push({ tick: e.tick, hash: e.hash }); break;
      }
    }
  }

  applyTransforms(b: TransformBatch): void {
    const s = this.store;
    for (const t of b.entries) {
      if (!s.isValid(t.id)) continue;
      const i = entityIndex(t.id);
      s.x[i] = t.x; s.y[i] = t.y; s.z[i] = t.z; s.yaw[i] = t.yaw; s.vx[i] = t.vx; s.vz[i] = t.vz; s.state[i] = t.state;
    }
    this.tick = b.tick;
  }

  /** Call after applying a full tick output; verifies any hash events for ticks we have fully applied. */
  verifyHashes(): void {
    for (const h of this.pendingHash) {
      if (h.tick === this.tick && this.store.hash() !== h.hash && this.desyncAt < 0) this.desyncAt = h.tick;
    }
    this.pendingHash = this.pendingHash.filter((h) => h.tick > this.tick);
  }
}
