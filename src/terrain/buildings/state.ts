// Mutable per-building state for gameplay: one "destroyed" bit per building of a map (bit i = Terrain.buildings[i]).
// The map itself (shapes, positions, seeded condition) never changes; this is the only part that does, so it is
// what multiplayer peers exchange: a few hundred bytes for a whole map (toBytes / fromBytes, or single changes).

export type BuildingStateListener = (id: number, destroyed: boolean) => void;

export class BuildingState {
  readonly count: number;
  private bits: Uint32Array;
  private listeners = new Set<BuildingStateListener>();
  /** Bumped on every change (cheap "did anything change" check for renderers / sync code). */
  version = 0;

  constructor(count: number) {
    this.count = count;
    this.bits = new Uint32Array(Math.ceil(count / 32));
  }

  isDestroyed(id: number): boolean {
    if (id < 0 || id >= this.count) return false;
    return ((this.bits[id >>> 5] >>> (id & 31)) & 1) === 1;
  }

  /** Sets one building's bit; listeners hear only real changes. */
  setDestroyed(id: number, destroyed = true): void {
    if (id < 0 || id >= this.count || this.isDestroyed(id) === destroyed) return;
    const mask = 1 << (id & 31);
    if (destroyed) this.bits[id >>> 5] |= mask;
    else this.bits[id >>> 5] &= ~mask;
    this.version++;
    for (const fn of this.listeners) fn(id, destroyed);
  }

  get destroyedCount(): number {
    let n = 0;
    for (let w of this.bits) {
      for (; w; n++) w &= w - 1;
    }
    return n;
  }

  /** Every building intact again. */
  reset(): void {
    for (let id = 0; id < this.count; id++) this.setDestroyed(id, false);
  }

  /** Called with (id, destroyed) after every change. Returns an unsubscribe function. */
  onChange(fn: BuildingStateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Packed bits, little-endian, ceil(count / 8) bytes: building i is bit (i & 7) of byte (i >> 3). */
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.count / 8));
    for (let i = 0; i < out.length; i++) out[i] = (this.bits[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
    return out;
  }

  /** Loads a snapshot made by toBytes (of a map with the same building count); listeners hear every change. */
  fromBytes(bytes: Uint8Array): void {
    for (let id = 0; id < this.count; id++) {
      const byte = bytes[id >>> 3] ?? 0;
      this.setDestroyed(id, ((byte >>> (id & 7)) & 1) === 1);
    }
  }
}
