// Grid pathfinding (A* / Dijkstra) over the N x N heightmap grid, 8-connected.

export interface PathQuery {
  N: number;
  /** Start cell index (j * N + i). */
  start: number;
  /** Cost of stepping from cell `a` to neighbour `b`; Infinity = impassable. */
  cost: (a: number, b: number, diagonal: boolean) => number;
  /** Search stops at the first goal cell reached. */
  isGoal: (cell: number) => boolean;
  /** Admissible estimate to the goal; omit for Dijkstra (e.g. many goal cells). */
  heuristic?: (cell: number) => number;
}

const DIRS: readonly [number, number, boolean][] = [
  [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
  [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true],
];

/** Cheapest path as cell indices from start to the reached goal, or null if unreachable. */
export function findPath({ N, start, cost, isGoal, heuristic = () => 0 }: PathQuery): number[] | null {
  const g = new Float64Array(N * N).fill(Infinity);
  const prev = new Int32Array(N * N).fill(-1);
  const closed = new Uint8Array(N * N);
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, heuristic(start));

  while (heap.size) {
    const c = heap.pop();
    if (closed[c]) continue;
    closed[c] = 1;
    if (isGoal(c)) {
      const path: number[] = [];
      for (let k = c; k !== -1; k = prev[k]) path.push(k);
      return path.reverse();
    }
    const cx = c % N, cy = (c - cx) / N;
    for (const [dx, dy, diag] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const n = ny * N + nx;
      if (closed[n]) continue;
      const step = cost(c, n, diag);
      if (step === Infinity) continue;
      const ng = g[c] + step;
      if (ng < g[n]) {
        g[n] = ng;
        prev[n] = c;
        heap.push(n, ng + heuristic(n));
      }
    }
  }
  return null;
}

/** Binary min-heap of (value, key) with lazy deletion handled by the caller. */
class MinHeap {
  private vals: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.vals.length;
  }

  push(val: number, key: number): void {
    const { vals, keys } = this;
    let i = vals.length;
    vals.push(val);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      vals[i] = vals[p];
      keys[i] = keys[p];
      i = p;
    }
    vals[i] = val;
    keys[i] = key;
  }

  pop(): number {
    const { vals, keys } = this;
    const top = vals[0];
    const lastVal = vals.pop()!;
    const lastKey = keys.pop()!;
    const n = vals.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r] < keys[l] ? r : l;
        if (keys[m] >= lastKey) break;
        vals[i] = vals[m];
        keys[i] = keys[m];
        i = m;
      }
      vals[i] = lastVal;
      keys[i] = lastKey;
    }
    return top;
  }
}
