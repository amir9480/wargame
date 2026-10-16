// Bridge decks as a height lookup: units on a bridge stand on the deck, not on the river bed below it (pure TS, from Terrain.roads).
//
// Every driveable bridge span is rasterised into 2 m cells (the deck's width plus a margin) holding the deck height; the
// ground height is raised to it where it is higher. Rail bridges are not walkable and are left out.
import type { Terrain } from '../../terrain/pipeline/types.ts';

const DECK_CELL = 2;
const KEY = 1 << 16;

export class BridgeDecks {
  private readonly cells = new Map<number, number>();
  private readonly half: number;

  constructor(t: Terrain) {
    this.half = t.worldSize / 2;
    for (const e of t.roads.edges) {
      if (e.type === 'rail' || !e.bridges.length) continue;
      const r = e.width / 2 + 0.6;
      for (const br of e.bridges) {
        for (let k = br.start; k < br.end; k++) {
          const a = e.points[k], b = e.points[k + 1];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const steps = Math.max(1, Math.ceil(len / 1));
          for (let s = 0; s <= steps; s++) {
            const f = s / steps;
            this.stamp(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, a.y + (b.y - a.y) * f, r);
          }
        }
      }
    }
  }

  private key(cx: number, cz: number): number { return cx * KEY + cz; }

  private stamp(x: number, z: number, y: number, r: number): void {
    const c0x = Math.floor((x - r + this.half) / DECK_CELL), c1x = Math.floor((x + r + this.half) / DECK_CELL);
    const c0z = Math.floor((z - r + this.half) / DECK_CELL), c1z = Math.floor((z + r + this.half) / DECK_CELL);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const px = (cx + 0.5) * DECK_CELL - this.half, pz = (cz + 0.5) * DECK_CELL - this.half;
      if (Math.hypot(px - x, pz - z) > r + DECK_CELL * 0.5) continue;
      const k = this.key(cx, cz);
      const old = this.cells.get(k);
      if (old === undefined || y > old) this.cells.set(k, y);
    }
  }

  /** Height to stand at: the deck when (x, z) is on a bridge and the deck is above the ground, else the ground. */
  heightAt(x: number, z: number, ground: number): number {
    if (!this.cells.size) return ground;
    const d = this.cells.get(this.key(Math.floor((x + this.half) / DECK_CELL), Math.floor((z + this.half) / DECK_CELL)));
    return d !== undefined && d > ground ? d : ground;
  }
}
