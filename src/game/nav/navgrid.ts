// Navigation grid for unit movement, built once from the generated Terrain (pure TS, no Three.js).
//
// 4 m cells over the whole map. Per mover class (foot / wheeled / tracked) a cost grid: 0 = blocked, otherwise a cost per cell
// (open ground 10, rough 14, light forest for infantry 22, ROAD 4). Blocked: water, steep slopes, outside the play area, map
// buildings, rocks, trees (vehicles: any tree; infantry: dense stands only), plus player structures (dynamic). Roads (not rail)
// are rasterised last and override everything except the play-area limit, so bridges stay passable and streets stay usable.
// Vehicle classes are inflated by one cell around blocked cells (they are wider than a cell centre line), roads excepted.
import { sampleGrid } from '../../terrain/grid.ts';
import type { Terrain } from '../../terrain/pipeline/types.ts';

export type Mover = 'foot' | 'wheeled' | 'tracked';
export const MOVERS: readonly Mover[] = ['foot', 'wheeled', 'tracked'];

export const NAV_CELL = 4;
export const COST_ROAD = 4;
export const COST_OPEN = 10;
const COST_ROUGH = 14;
const COST_FOREST = 22;
/** Maximum slope (rise / run) per class; cells above 60% of it are "rough". */
const MAX_SLOPE: Record<Mover, number> = { foot: 0.85, wheeled: 0.42, tracked: 0.55 };

// object flags (for placement checks and debugging)
export const OBJ_TREE = 1, OBJ_ROCK = 2, OBJ_BUILDING = 4, OBJ_ROAD = 8;

/** Heuristic weight: slightly above the open-ground cost so the search stays focused (weighted A*). */
const HEURISTIC = 7;
const MAX_EXPANSIONS = 220_000;
const HEAP_CAP = 1 << 21;
const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

export class NavGrid {
  readonly n: number;
  readonly origin: number;
  readonly cost: Record<Mover, Uint8Array>;
  /** OBJ_* flags per cell. */
  readonly obj: Uint8Array;
  private readonly treeCount: Uint8Array;
  readonly road: Uint8Array;
  /** Player structure footprints (count per cell); blocks every class. */
  private dyn: Uint8Array;
  /** Bumped whenever the dynamic obstacles change (paths crossing them must be re-checked). */
  epoch = 0;
  private playHalf: number;

  // A* working memory (reused between searches)
  private readonly gScore: Float32Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private stamp = 0;
  private readonly heapF = new Float32Array(HEAP_CAP);
  private readonly heapI = new Int32Array(HEAP_CAP);
  private heapN = 0;

  constructor(t: Terrain) {
    this.n = Math.ceil(t.worldSize / NAV_CELL);
    this.origin = -t.worldSize / 2;
    const n = this.n;
    const cells = n * n;
    this.playHalf = t.playSize / 2 - 6;
    this.obj = new Uint8Array(cells);
    this.treeCount = new Uint8Array(cells);
    this.road = new Uint8Array(cells);
    this.dyn = new Uint8Array(cells);
    this.cost = { foot: new Uint8Array(cells), wheeled: new Uint8Array(cells), tracked: new Uint8Array(cells) };
    this.gScore = new Float32Array(cells);
    this.parent = new Int32Array(cells);
    this.seen = new Uint32Array(cells);
    this.closed = new Uint32Array(cells);

    // ground height at cell centres, and slope from it
    const h = new Float32Array(cells);
    const half = t.worldSize / 2;
    for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) {
      h[cz * n + cx] = sampleGrid(t.heights, t.size, (this.cx(cx) + half) / t.cell, (this.cx(cz) + half) / t.cell);
    }
    const slope = new Float32Array(cells);
    for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) {
      const i = cz * n + cx;
      let m = 0;
      if (cx > 0) m = Math.max(m, Math.abs(h[i] - h[i - 1]));
      if (cx < n - 1) m = Math.max(m, Math.abs(h[i] - h[i + 1]));
      if (cz > 0) m = Math.max(m, Math.abs(h[i] - h[i - n]));
      if (cz < n - 1) m = Math.max(m, Math.abs(h[i] - h[i + n]));
      slope[i] = m / NAV_CELL;
    }

    // objects
    for (const tr of t.trees.trees) {
      const i = this.idx(this.cellOf(tr.x), this.cellOf(tr.z));
      if (i >= 0 && this.treeCount[i] < 255) this.treeCount[i]++;
    }
    for (const r of t.rocks) this.stampDisc(r.x, r.z, r.size * 0.9 + 1.2, OBJ_ROCK);
    for (const b of t.buildings) this.stampRect(b.x, b.z, b.width / 2 + 2, b.depth / 2 + 2, b.yaw, OBJ_BUILDING);
    for (const e of t.roads.edges) {
      if (e.type === 'rail') continue;
      const r = Math.max(e.width / 2, 2) + 1.2;
      for (let k = 0; k + 1 < e.points.length; k++) {
        const a = e.points[k], b = e.points[k + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(len / 1.5));
        for (let s = 0; s <= steps; s++) this.stampRoad(a.x + ((b.x - a.x) * s) / steps, a.z + ((b.z - a.z) * s) / steps, r);
      }
    }
    for (let i = 0; i < cells; i++) {
      if (this.treeCount[i] > 0) this.obj[i] |= OBJ_TREE;
    }

    // per class cost
    for (const m of MOVERS) {
      const c = this.cost[m];
      const limit = MAX_SLOPE[m];
      for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) {
        const i = cz * n + cx;
        const x = this.cx(cx), z = this.cx(cz);
        if (Math.abs(x) > this.playHalf || Math.abs(z) > this.playHalf) { c[i] = 0; continue; }
        if (this.road[i]) { c[i] = COST_ROAD; continue; }
        if (h[i] <= 0.3 || slope[i] > limit || this.obj[i] & (OBJ_ROCK | OBJ_BUILDING)) { c[i] = 0; continue; }
        const trees = this.treeCount[i];
        if (m === 'foot') c[i] = trees >= 3 ? 0 : trees > 0 ? COST_FOREST : slope[i] > limit * 0.6 ? COST_ROUGH : COST_OPEN;
        else c[i] = trees > 0 ? 0 : slope[i] > limit * 0.6 ? COST_ROUGH : COST_OPEN;
      }
    }
    // vehicles are wider than a cell: keep one cell away from blocked cells (roads stay open)
    for (const m of ['wheeled', 'tracked'] as const) {
      const c = this.cost[m];
      const src = c.slice();
      for (let cz = 1; cz < n - 1; cz++) for (let cx = 1; cx < n - 1; cx++) {
        const i = cz * n + cx;
        if (src[i] === 0 || this.road[i]) continue;
        if (src[i - 1] === 0 || src[i + 1] === 0 || src[i - n] === 0 || src[i + n] === 0 || src[i - n - 1] === 0 || src[i - n + 1] === 0 || src[i + n - 1] === 0 || src[i + n + 1] === 0) c[i] = 0;
      }
    }
  }

  // ---- coordinates ----------------------------------------------------------------------------------------------
  cellOf(v: number): number { return Math.floor((v - this.origin) / NAV_CELL); }
  /** World coordinate of a cell centre along one axis. */
  cx(c: number): number { return this.origin + (c + 0.5) * NAV_CELL; }
  idx(cx: number, cz: number): number { return cx < 0 || cz < 0 || cx >= this.n || cz >= this.n ? -1 : cz * this.n + cx; }

  private stampDisc(x: number, z: number, r: number, flag: number): void {
    const c0x = this.cellOf(x - r), c1x = this.cellOf(x + r), c0z = this.cellOf(z - r), c1z = this.cellOf(z + r);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const i = this.idx(cx, cz);
      if (i >= 0 && Math.hypot(this.cx(cx) - x, this.cx(cz) - z) <= r + NAV_CELL * 0.35) this.obj[i] |= flag;
    }
  }

  /** Oriented rectangle (local +Z = front along (sin yaw, cos yaw)); `flag` into `obj`, or +/-1 into the dynamic counts. */
  private stampRect(x: number, z: number, hw: number, hd: number, yaw: number, flag: number, dyn = 0): void {
    const r = Math.hypot(hw, hd);
    const c0x = this.cellOf(x - r), c1x = this.cellOf(x + r), c0z = this.cellOf(z - r), c1z = this.cellOf(z + r);
    const s = Math.sin(yaw), co = Math.cos(yaw);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const i = this.idx(cx, cz);
      if (i < 0) continue;
      const dx = this.cx(cx) - x, dz = this.cx(cz) - z;
      const lx = dx * co - dz * s, lz = dx * s + dz * co; // into the rect's frame
      if (Math.abs(lx) <= hw + NAV_CELL * 0.25 && Math.abs(lz) <= hd + NAV_CELL * 0.25) {
        if (dyn) this.dyn[i] = Math.max(0, Math.min(255, this.dyn[i] + dyn)); else this.obj[i] |= flag;
      }
    }
  }

  private stampRoad(x: number, z: number, r: number): void {
    const cx = this.cellOf(x), cz = this.cellOf(z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const i = this.idx(cx + dx, cz + dz);
      if (i < 0) continue;
      if ((dx === 0 && dz === 0) || Math.hypot(this.cx(cx + dx) - x, this.cx(cz + dz) - z) <= r) { this.road[i] = 1; this.obj[i] |= OBJ_ROAD; }
    }
  }

  // ---- dynamic obstacles (player structures) ---------------------------------------------------------------------
  addFootprint(x: number, z: number, width: number, depth: number, yaw: number): void {
    this.stampRect(x, z, width / 2 + 2, depth / 2 + 2, yaw, 0, 1);
    this.epoch++;
  }

  removeFootprint(x: number, z: number, width: number, depth: number, yaw: number): void {
    this.stampRect(x, z, width / 2 + 2, depth / 2 + 2, yaw, 0, -1);
    this.epoch++;
  }

  clearDynamic(): void {
    this.dyn.fill(0);
    this.epoch++;
  }

  // ---- queries ---------------------------------------------------------------------------------------------------
  passable(m: Mover, i: number): boolean {
    return i >= 0 && this.cost[m][i] > 0 && this.dyn[i] === 0;
  }

  /** Movement speed multiplier at a world position (roads are faster). */
  speedFactor(m: Mover, x: number, z: number): number {
    const i = this.idx(this.cellOf(x), this.cellOf(z));
    return i >= 0 && this.road[i] ? (m === 'foot' ? 1.15 : 1.5) : 1;
  }

  isRoad(x: number, z: number): boolean {
    const i = this.idx(this.cellOf(x), this.cellOf(z));
    return i >= 0 && this.road[i] === 1;
  }

  /** True when a circle of `r` metres is clear of trees, rocks, buildings and roads (structure placement). */
  buildableCircle(x: number, z: number, r: number): boolean {
    const c0x = this.cellOf(x - r - 2), c1x = this.cellOf(x + r + 2), c0z = this.cellOf(z - r - 2), c1z = this.cellOf(z + r + 2);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const i = this.idx(cx, cz);
      if (i < 0) return false;
      if (this.obj[i] !== 0 && Math.hypot(this.cx(cx) - x, this.cx(cz) - z) <= r + NAV_CELL * 0.75) return false;
    }
    return true;
  }

  /** Straight line free of obstacles for this class (sampled every metre). */
  los(m: Mover, ax: number, az: number, bx: number, bz: number): boolean {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(dist / 1));
    let last = -2;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const i = this.idx(this.cellOf(ax + (bx - ax) * f), this.cellOf(az + (bz - az) * f));
      if (i === last) continue;
      last = i;
      if (!this.passable(m, i)) return false;
    }
    return true;
  }

  /** Nearest passable cell to (cx, cz) within `maxR` cells, or -1. */
  nearestFree(m: Mover, cx: number, cz: number, maxR: number): number {
    const first = this.idx(cx, cz);
    if (first >= 0 && this.passable(m, first)) return first;
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= maxR; r++) {
      if (best >= 0 && r > Math.sqrt(bestD) + 1) break;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const i = this.idx(cx + dx, cz + dz);
        if (i < 0 || !this.passable(m, i)) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  // ---- A* ----------------------------------------------------------------------------------------------------------
  private push(f: number, i: number): void {
    let k = this.heapN++;
    const hf = this.heapF, hi = this.heapI;
    if (k >= HEAP_CAP) { this.heapN--; return; }
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hf[p] <= f) break;
      hf[k] = hf[p]; hi[k] = hi[p];
      k = p;
    }
    hf[k] = f; hi[k] = i;
  }

  private pop(): number {
    const hf = this.heapF, hi = this.heapI;
    const top = hi[0];
    const n = --this.heapN;
    if (n > 0) {
      const f = hf[n], i = hi[n];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= f) break;
        hf[k] = hf[c]; hi[k] = hi[c];
        k = c;
      }
      hf[k] = f; hi[k] = i;
    }
    return top;
  }

  /**
   * Weighted A* (8-connected, no corner cutting) from (sx, sz) to (gx, gz) for a mover class, then string-pulled with line of
   * sight. Returns flat world waypoints [x0, z0, x1, z1, ...] (the start itself excluded, the goal last), or null when the
   * goal is unreachable. An unreachable-in-budget search returns the path to the explored cell closest to the goal.
   */
  findPath(m: Mover, sx: number, sz: number, gx: number, gz: number): number[] | null {
    const n = this.n;
    const cost = this.cost[m];
    const s = this.nearestFree(m, this.cellOf(sx), this.cellOf(sz), 8);
    const g = this.nearestFree(m, this.cellOf(gx), this.cellOf(gz), 30);
    if (s < 0 || g < 0) return null;
    const gcx = g % n, gcz = (g / n) | 0;
    const goalX = this.passable(m, this.idx(this.cellOf(gx), this.cellOf(gz))) ? gx : this.cx(gcx);
    const goalZ = this.passable(m, this.idx(this.cellOf(gx), this.cellOf(gz))) ? gz : this.cx(gcz);
    if (s === g) return [goalX, goalZ];

    const st = ++this.stamp;
    this.heapN = 0;
    this.gScore[s] = 0; this.seen[s] = st; this.parent[s] = -1;
    const h = (i: number): number => {
      const dx = Math.abs((i % n) - gcx), dz = Math.abs(((i / n) | 0) - gcz);
      return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * HEURISTIC;
    };
    this.push(h(s), s);
    let expansions = 0, best = s, bestH = h(s), found = false;
    while (this.heapN > 0) {
      const cur = this.pop();
      if (this.closed[cur] === st) continue;
      this.closed[cur] = st;
      if (cur === g) { found = true; break; }
      if (++expansions > MAX_EXPANSIONS) break;
      const cx = cur % n, cz = (cur / n) | 0;
      const gc = this.gScore[cur];
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d], nz = cz + DZ[d];
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx;
        if (cost[ni] === 0 || this.dyn[ni] !== 0 || this.closed[ni] === st) continue;
        if (d >= 4) { // diagonal: both orthogonal neighbours must be free (no corner cutting)
          const a = cz * n + nx, b = nz * n + cx;
          if (cost[a] === 0 || this.dyn[a] !== 0 || cost[b] === 0 || this.dyn[b] !== 0) continue;
        }
        const ng = gc + cost[ni] * (d >= 4 ? SQRT2 : 1);
        if (this.seen[ni] !== st || ng < this.gScore[ni]) {
          this.seen[ni] = st; this.gScore[ni] = ng; this.parent[ni] = cur;
          const hv = h(ni);
          this.push(ng + hv, ni);
          if (hv < bestH) { bestH = hv; best = ni; }
        }
      }
    }
    const end = found ? g : best;
    const cells: number[] = [];
    for (let c = end; c !== -1; c = this.parent[c]) cells.push(c);
    cells.reverse();
    // waypoints: cell centres, then string-pulled with line of sight (look-ahead window keeps it cheap)
    const raw: number[] = [];
    for (let k = 1; k < cells.length; k++) raw.push(this.cx(cells[k] % n), this.cx((cells[k] / n) | 0));
    if (found) { raw[raw.length - 2] = goalX; raw[raw.length - 1] = goalZ; }
    return this.smooth(m, sx, sz, raw);
  }

  private smooth(m: Mover, sx: number, sz: number, raw: number[]): number[] {
    const out: number[] = [];
    const count = raw.length / 2;
    let px = sx, pz = sz, i = 0;
    while (i < count) {
      let j = Math.min(count - 1, i + 60);
      while (j > i && !this.los(m, px, pz, raw[j * 2], raw[j * 2 + 1])) j--;
      out.push(raw[j * 2], raw[j * 2 + 1]);
      px = raw[j * 2]; pz = raw[j * 2 + 1];
      i = j + 1;
    }
    return out;
  }
}
