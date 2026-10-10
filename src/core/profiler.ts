// Profiler: categorised CPU scopes, GPU pass timing, counters and frame statistics, recorded on demand and summarised
// as a text report for debugging and bottleneck detection.
//
//  - Scopes: `profiler.scope('cull', 'main view', () => ...)` or `const t = profiler.begin(cat, name); ...; profiler.end(t)`.
//    Scopes nest; the report uses self time (own time without nested scopes), so categories add up to the frame.
//  - Passes: `profiler.pass(name, () => renderer.render(...))` = a CPU scope in category `render`, plus a GPU timer
//    query (when the GpuProbe supports it) and the draw calls / triangles the pass issued.
//  - Counters: `profiler.count(cat, name, value)` samples a value (per frame / per event), reported as min / avg / p95 / max.
//  - Frames: `beginFrame(now)` / `endFrame()` give wall time (rAF to rAF), CPU time, worst frames and their scopes.
//
// Everything is a single boolean check while not recording, so instrumentation can stay in the code everywhere.
// No Three.js dependency: the render side attaches a `GpuProbe` and an `InfoProvider`.

/** GPU timer queries of the render side (render/gpuTimer.ts). Queries must not nest: the profiler only opens the outermost. */
export interface GpuProbe {
  readonly supported: boolean;
  begin(name: string, frame: number): void;
  end(): void;
  /** Drops queries in flight (a new recording starts). */
  reset(): void;
  /** Hands every finished query to `sink` (results arrive a few frames late). */
  poll(sink: (name: string, ms: number, frame: number) => void): void;
}

/** Renderer counters at this moment (the profiler takes differences between two reads). */
export interface RenderInfo {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
}
export type InfoProvider = () => RenderInfo;

interface Series {
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Samples kept for percentiles (decimated once full). */
  samples: number[];
  stride: number;
  skip: number;
}

interface Scope extends Series {
  cat: string;
  name: string;
  /** Total self time (ms) = sum. `inclusive` includes nested scopes. */
  inclusive: number;
}

interface OpenScope {
  key: string;
  start: number;
  child: number;
}

interface WorstFrame {
  at: number;
  wall: number;
  cpu: number;
  top: [string, number][];
}

/** A render pass with its parts (`<group>: <part>` GPU scopes), see `Profiler.group`. */
interface GpuGroup {
  name: string;
  /** GPU time in ms over the recording (part sums, minus the per-part render overhead in detail mode). */
  sum: number;
  parts: Scope[];
  /** The group measured as one pass (no parts). */
  single: Scope | null;
  /** Detail mode: ms every part's separate render costs by itself (an empty render), and that probe. */
  overhead: number;
  overheadScope: Scope | null;
}
/** Part name of the empty-render probe (Lighting.drawLayers). */
const OVERHEAD = 'overhead (empty render)';

/** Name of the full post pass and the prefix of its feature-ablation probes (Lighting.render, detail mode). */
export const POST_PASS = 'post (shadows + AO + lights + grade)';
export const ABLATION = 'post without: ';

const MAX_SAMPLES = 20000;
const REFRESH_RATES = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];

function series(): Series {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [], stride: 1, skip: 0 };
}

function push(s: Series, v: number): void {
  s.count++;
  s.sum += v;
  if (v < s.min) s.min = v;
  if (v > s.max) s.max = v;
  if (s.skip > 0) {
    s.skip--;
    return;
  }
  s.samples.push(v);
  s.skip = s.stride - 1;
  if (s.samples.length >= MAX_SAMPLES) {
    // Keep every second sample from now on (an even spread over the whole recording).
    s.samples = s.samples.filter((_, i) => i % 2 === 0);
    s.stride *= 2;
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

function sortedCopy(s: Series): number[] {
  return s.samples.slice().sort((a, b) => a - b);
}

const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '-');
const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '-');
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

export class Profiler {
  private recording = false;
  private t0 = 0;
  private tEnd = 0;

  private scopes = new Map<string, Scope>();
  private counters = new Map<string, Series>();
  private stack: OpenScope[] = [];
  private notes: string[] = [];
  private contexts: (() => Record<string, string>)[] = [];

  // Frames
  private frameIndex = 0;
  private frameStart = 0;
  private lastFrameStart = -1;
  /** Wall time of the previous frame (rAF to rAF), ms. */
  private lastWall = 0;
  private wall = series();
  private cpu = series();
  private frameAcc = new Map<string, number>();
  private worst: WorstFrame[] = [];
  private longFrames = [0, 0, 0]; // > 16.7 / 33.3 / 50 ms wall
  private frames = 0;

  // GPU
  private gpuProbe: GpuProbe | null = null;
  private gpuFrames = new Map<number, number>();
  private passDepth = 0;
  private detailOption = false;
  private info: InfoProvider | null = null;

  // Memory
  private heapStart = 0;
  private heapMax = 0;
  private heapSamples = 0;
  private lastHeapAt = 0;

  /** Recording in progress. */
  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Detail mode (set before `start`): render passes that have parts (the scene and shadow map per layer, bloom / AO / god rays
   * per full-screen pass) are timed part by part, and the post shader is probed with features switched off. Slightly slower
   * than the normal frame (more state changes), so the numbers run a little high; the shares are what counts.
   */
  setDetailed(on: boolean): void {
    this.detailOption = on;
  }
  /** True while recording in detail mode. */
  get detailed(): boolean {
    return this.recording && this.detailOption;
  }
  /** Seconds since the recording started (0 when not recording). */
  get elapsed(): number {
    return this.recording ? (performance.now() - this.t0) / 1000 : 0;
  }
  get frameCount(): number {
    return this.frames;
  }

  attachGpu(probe: GpuProbe | null): void {
    this.gpuProbe = probe;
  }
  attachInfo(provider: InfoProvider | null): void {
    this.info = provider;
  }
  /** Adds key / value lines to the report's environment section (evaluated when the recording stops). */
  addContext(provider: () => Record<string, string>): void {
    this.contexts.push(provider);
  }
  /** Free-form line for the report (e.g. "quality changed to low"), time-stamped. */
  note(text: string): void {
    if (this.recording) this.notes.push(`${f1((performance.now() - this.t0) / 1000)}s  ${text}`);
  }

  start(): void {
    this.scopes.clear();
    this.counters.clear();
    this.stack = [];
    this.notes = [];
    this.worst = [];
    this.longFrames = [0, 0, 0];
    this.frames = 0;
    this.frameIndex = 0;
    this.lastFrameStart = -1;
    this.lastWall = 0;
    this.wall = series();
    this.cpu = series();
    this.frameAcc.clear();
    this.gpuFrames.clear();
    this.gpuProbe?.reset();
    this.passDepth = 0;
    this.heapStart = this.heapNow();
    this.heapMax = this.heapStart;
    this.heapSamples = 0;
    this.lastHeapAt = 0;
    this.t0 = performance.now();
    this.recording = true;
  }

  /** Stops recording and returns the report text. */
  stop(): string {
    if (!this.recording) return '';
    // Give the last GPU queries a moment: poll once more.
    this.pollGpu();
    this.recording = false;
    this.tEnd = performance.now();
    return this.report();
  }

  // ---------------------------------------------------------------- scopes

  /** Opens a scope; returns a token for `end` (-1 when not recording). */
  begin(cat: string, name: string): number {
    if (!this.recording) return -1;
    this.stack.push({ key: `${cat}\u0000${name}`, start: performance.now(), child: 0 });
    return this.stack.length;
  }

  end(token: number): void {
    if (token < 0 || !this.recording) return;
    const now = performance.now();
    // An exception may have skipped inner ends: close everything above `token` first.
    while (this.stack.length > token) this.close(now);
    if (this.stack.length === token) this.close(now);
  }

  private close(now: number): void {
    const open = this.stack.pop()!;
    const total = now - open.start;
    const self = Math.max(0, total - open.child);
    if (this.stack.length) this.stack[this.stack.length - 1].child += total;
    this.addSample(open.key, self, total);
  }

  /** Runs `fn` inside a scope. */
  scope<T>(cat: string, name: string, fn: () => T): T {
    if (!this.recording) return fn();
    const t = this.begin(cat, name);
    try {
      return fn();
    } finally {
      this.end(t);
    }
  }

  /** Records a duration measured elsewhere (async work, worker events) as a scope sample. */
  sample(cat: string, name: string, ms: number): void {
    if (this.recording) this.addSample(`${cat}\u0000${name}`, ms, ms);
  }

  private addSample(key: string, self: number, total: number): void {
    let s = this.scopes.get(key);
    if (!s) {
      const [cat, name] = key.split('\u0000');
      s = { ...series(), cat, name, inclusive: 0 };
      this.scopes.set(key, s);
    }
    push(s, self);
    s.inclusive += total;
    if (!key.startsWith('gpu\u0000')) this.frameAcc.set(key, (this.frameAcc.get(key) ?? 0) + self);
  }

  /** Samples a value (draw calls, instances, chunk counts...) into a named series. */
  count(cat: string, name: string, value: number): void {
    if (!this.recording) return;
    const key = `${cat}\u0000${name}`;
    let s = this.counters.get(key);
    if (!s) this.counters.set(key, (s = series()));
    push(s, value);
  }

  // ---------------------------------------------------------------- render passes

  /**
   * A render pass: CPU scope `render/<name>`, a GPU timer query `<name>` (outermost pass only) and the draw calls /
   * triangles it issued (counters `draw calls` / `triangles`, per pass).
   */
  pass<T>(name: string, fn: () => T): T {
    if (!this.recording) return fn();
    const outer = this.passDepth++ === 0;
    const before = outer && this.info ? this.info() : null;
    const probe = this.gpuProbe;
    if (outer && probe?.supported) probe.begin(name, this.frameIndex);
    const t = this.begin('render', name);
    try {
      return fn();
    } finally {
      this.end(t);
      if (outer && probe?.supported) probe.end();
      if (before && this.info) {
        const after = this.info();
        this.count('draw calls', name, after.calls - before.calls);
        this.count('triangles', name, after.triangles - before.triangles);
      }
      this.passDepth--;
    }
  }

  /**
   * A pass made of parts. Normally one `pass(name)`; in detail mode it only runs `fn`, whose `part(name, ...)` calls become the
   * passes `<name>: <part>` (GPU queries can't nest, so the group itself isn't queried then). The report sums the parts.
   */
  group<T>(name: string, fn: () => T): T {
    return this.detailed ? fn() : this.pass(name, fn);
  }

  /** One part of a `group`: a pass `<group>: <part>` in detail mode, just `fn` otherwise. */
  part<T>(group: string, part: string, fn: () => T): T {
    return this.detailed && group ? this.pass(`${group}: ${part}`, fn) : fn();
  }

  private pollGpu(): void {
    this.gpuProbe?.poll((name, ms, frame) => {
      this.addSample(`gpu\u0000${name}`, ms, ms);
      this.gpuFrames.set(frame, (this.gpuFrames.get(frame) ?? 0) + ms);
    });
  }

  // ---------------------------------------------------------------- frames

  /** Call at the start of every animation frame. */
  beginFrame(): void {
    if (!this.recording) return;
    const now = performance.now();
    if (this.lastFrameStart >= 0) {
      const wall = now - this.lastFrameStart;
      this.lastWall = wall;
      push(this.wall, wall);
      if (wall > 16.7) this.longFrames[0]++;
      if (wall > 33.3) this.longFrames[1]++;
      if (wall > 50) this.longFrames[2]++;
    }
    this.lastFrameStart = now;
    this.frameStart = now;
    this.frameIndex++;
    this.frameAcc.clear();
    this.pollGpu();
    const rel = now - this.t0;
    if (rel - this.lastHeapAt > 500) {
      this.lastHeapAt = rel;
      const heap = this.heapNow();
      if (heap > 0) {
        this.heapMax = Math.max(this.heapMax, heap);
        this.heapSamples++;
        this.count('memory', 'JS heap (MB)', heap);
      }
    }
  }

  endFrame(): void {
    if (!this.recording) return;
    const now = performance.now();
    const cpu = now - this.frameStart;
    push(this.cpu, cpu);
    this.frames++;
    const wall = this.lastWall || cpu;
    // Keep the 8 slowest frames (by CPU time) with their biggest scopes.
    const w = this.worst;
    if (w.length < 8 || cpu > w[w.length - 1].cpu) {
      const top = [...this.frameAcc].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]): [string, number] => [k.replace('\u0000', '/'), v]);
      w.push({ at: (now - this.t0) / 1000, wall, cpu, top });
      w.sort((a, b) => b.cpu - a.cpu);
      if (w.length > 8) w.length = 8;
    }
  }

  private heapNow(): number {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? mem.usedJSHeapSize / (1024 * 1024) : 0;
  }

  // ---------------------------------------------------------------- report

  private report(): string {
    const out: string[] = [];
    const secs = (this.tEnd - this.t0) / 1000;
    const frames = Math.max(1, this.frames);
    const wallSorted = sortedCopy(this.wall);
    const cpuSorted = sortedCopy(this.cpu);
    const wallAvg = this.wall.count ? this.wall.sum / this.wall.count : 0;
    const cpuAvg = this.cpu.count ? this.cpu.sum / this.cpu.count : 0;
    const gpuAvg = this.gpuProbe?.supported && this.gpuFrames.size ? [...this.gpuFrames.values()].reduce((a, b) => a + b, 0) / this.gpuFrames.size : NaN;
    const gpuFrameSorted = [...this.gpuFrames.values()].sort((a, b) => a - b);

    out.push('=== PROFILER REPORT ===');
    out.push(`recorded ${f1(secs)} s, ${this.frames} frames, ${f1(wallAvg ? 1000 / wallAvg : 0)} fps average`);
    out.push('');

    out.push('-- Environment --');
    for (const provider of this.contexts) {
      try {
        for (const [k, v] of Object.entries(provider())) out.push(`${pad(k, 18)} ${v}`);
      } catch {
        // a context provider failed: leave its lines out
      }
    }
    out.push(`${pad('gpu timing', 18)} ${this.gpuProbe?.supported ? 'EXT_disjoint_timer_query_webgl2' : 'unavailable (CPU timings only)'}`);
    out.push(`${pad('detail mode', 18)} ${this.detailOption ? 'on: scene / shadow map drawn per layer, bloom / AO / god rays per pass, post shader probed with features off (frame times run a little high)' : 'off'}`);
    out.push('');

    // ---- frame time
    out.push('-- Frame time (ms) --');
    out.push(`${pad('', 10)}${padL('avg', 8)}${padL('p50', 8)}${padL('p95', 8)}${padL('p99', 8)}${padL('max', 8)}`);
    const row = (label: string, avg: number, sorted: number[], max: number) =>
      out.push(`${pad(label, 10)}${padL(f2(avg), 8)}${padL(f2(percentile(sorted, 0.5)), 8)}${padL(f2(percentile(sorted, 0.95)), 8)}${padL(f2(percentile(sorted, 0.99)), 8)}${padL(f2(max), 8)}`);
    row('wall', wallAvg, wallSorted, this.wall.max);
    row('cpu', cpuAvg, cpuSorted, this.cpu.max);
    if (gpuFrameSorted.length) row('gpu', gpuAvg, gpuFrameSorted, gpuFrameSorted[gpuFrameSorted.length - 1]);
    const wallN = Math.max(1, this.wall.count);
    out.push(`1% low fps ${f1(1000 / Math.max(1e-3, percentile(wallSorted, 0.99)))} | frames over 16.7 ms: ${f1((100 * this.longFrames[0]) / wallN)}%, over 33 ms: ${f1((100 * this.longFrames[1]) / wallN)}%, over 50 ms: ${f1((100 * this.longFrames[2]) / wallN)}%`);
    out.push('');

    // ---- verdict
    const refreshMs = this.estimateRefreshMs(wallSorted);
    const verdict = this.verdict(wallAvg, cpuAvg, gpuAvg, refreshMs);
    out.push('-- Bottleneck --');
    out.push(...verdict.lines);
    out.push('');

    // ---- CPU categories + scopes
    const cpuScopes = [...this.scopes.values()].filter((s) => s.cat !== 'gpu');
    const cpuTotal = cpuScopes.reduce((a, s) => a + s.sum, 0);
    const byCat = new Map<string, number>();
    for (const s of cpuScopes) byCat.set(s.cat, (byCat.get(s.cat) ?? 0) + s.sum);
    out.push('-- CPU by category (self time, ms per frame, share of main-thread frame time) --');
    for (const [cat, sum] of [...byCat].sort((a, b) => b[1] - a[1])) {
      out.push(`${pad(cat, 18)}${padL(f2(sum / frames), 8)} ms${padL(f1((100 * sum) / Math.max(1e-3, cpuAvg * frames)), 7)}%`);
    }
    const untracked = cpuAvg * frames - cpuTotal;
    if (untracked > 0 && this.cpu.count) out.push(`${pad('(untracked)', 18)}${padL(f2(untracked / frames), 8)} ms${padL(f1((100 * untracked) / Math.max(1e-3, cpuAvg * frames)), 7)}%`);
    out.push('');

    out.push('-- CPU scopes, top 30 by total self time (ms: total / per frame / avg per call / p95 / max; calls) --');
    out.push(`${pad('scope', 40)}${padL('total', 9)}${padL('/frame', 8)}${padL('avg', 8)}${padL('p95', 8)}${padL('max', 8)}${padL('calls', 8)}`);
    for (const s of cpuScopes.sort((a, b) => b.sum - a.sum).slice(0, 30)) {
      const sorted = sortedCopy(s);
      out.push(`${pad(`${s.cat}/${s.name}`, 40)}${padL(f1(s.sum), 9)}${padL(f2(s.sum / frames), 8)}${padL(f2(s.sum / s.count), 8)}${padL(f2(percentile(sorted, 0.95)), 8)}${padL(f2(s.max), 8)}${padL(String(s.count), 8)}`);
    }
    out.push('');

    // ---- GPU
    const gpuScopes = [...this.scopes.values()].filter((s) => s.cat === 'gpu').sort((a, b) => b.sum - a.sum);
    const gpuGroups = this.gpuGroups(gpuScopes);
    if (gpuGroups.length) {
      const gpuSum = gpuGroups.reduce((a, g) => a + g.sum, 0);
      const line = (label: string, s: Scope, share: number) => {
        const sorted = sortedCopy(s);
        out.push(`${pad(label, 44)}${padL(f2(s.sum / frames), 8)}${padL(f2(s.sum / s.count), 8)}${padL(f2(percentile(sorted, 0.95)), 8)}${padL(f2(s.max), 8)}${padL(f1(100 * share), 7)}%`);
      };
      out.push('-- GPU passes (ms: per frame / avg per call / p95 / max; share of GPU time; parts indented, share of their group) --');
      for (const g of gpuGroups) {
        if (g.single) line(g.name, g.single, g.single.sum / Math.max(1e-3, gpuSum));
        if (g.parts.length) {
          out.push(`${pad(`${g.name}${g.single ? ' (+ parts)' : ''}`, 44)}${padL(f2(g.sum / frames), 8)}${pad('', 32)}${padL(f1((100 * g.sum) / Math.max(1e-3, gpuSum)), 7)}%`);
          for (const p of g.parts) line(`  ${p.name.slice(g.name.length + 2)}`, p, this.partCost(g, p) / Math.max(1e-3, g.sum));
          if (g.overheadScope) {
            out.push(`  (the part times above include ${f2(g.overhead)} ms each for being a separate render: MSAA resolve + state setup; shares and the group total have it taken out, one render's worth stays)`);
          }
        }
      }
      out.push('');

      // Post shader A/B: the same pass with one feature switched off on a few frames (detail mode).
      const full = gpuScopes.find((s) => s.name === POST_PASS);
      const ablations = gpuScopes.filter((s) => s.name.startsWith(ABLATION) && s.count >= 5);
      if (full && ablations.length) {
        const fullAvg = full.sum / full.count;
        out.push(`-- Post shader feature cost (A/B: ${POST_PASS} = ${f2(fullAvg)} ms avg; each feature probed switched off on ~1 frame in 30) --`);
        for (const a of ablations.sort((x, y) => x.sum / x.count - y.sum / y.count)) {
          const avg = a.sum / a.count;
          out.push(`${pad(a.name.slice(ABLATION.length), 44)}${padL(f2(avg), 8)} ms   feature costs ${padL(f2(fullAvg - avg), 6)} ms (${f1((100 * (fullAvg - avg)) / Math.max(1e-3, fullAvg))}% of the pass)   [${a.count} samples]`);
        }
        out.push('(negative / ~0 values are noise or a feature that is off at this quality)');
        out.push('');
      }
    }

    // ---- counters
    if (this.counters.size) {
      out.push('-- Counters (per sample: avg / p95 / min / max) --');
      for (const [key, s] of [...this.counters].sort((a, b) => a[0].localeCompare(b[0]))) {
        const sorted = sortedCopy(s);
        const big = s.max >= 1000;
        const fmt = (n: number) => (big ? Math.round(n).toLocaleString('en-US') : f1(n));
        out.push(`${pad(key.replace('\u0000', '/'), 40)}${padL(fmt(s.sum / s.count), 12)}${padL(fmt(percentile(sorted, 0.95)), 12)}${padL(fmt(s.min), 12)}${padL(fmt(s.max), 12)}`);
      }
      // Sums of the parts of a group (detail mode): the whole pass's draw calls / triangles per frame.
      for (const kind of ['draw calls', 'triangles']) {
        for (const g of gpuGroups) {
          const total = this.groupCounter(kind, g.name);
          if (total !== null && g.parts.length) out.push(`${pad(`${kind}/${g.name} (sum of parts)`, 40)}${padL(Math.round(total).toLocaleString('en-US'), 12)}`);
        }
      }
      out.push('');
    }

    // ---- worst frames
    if (this.worst.length) {
      out.push('-- Slowest frames (cpu ms; biggest scopes inside) --');
      for (const w of this.worst) {
        out.push(`t=${padL(f1(w.at), 6)}s cpu ${padL(f1(w.cpu), 6)} wall ${padL(f1(w.wall), 6)}  ${w.top.map(([k, v]) => `${k} ${f1(v)}`).join(' | ')}`);
      }
      out.push('');
    }

    if (this.notes.length) {
      out.push('-- Events during the recording --');
      out.push(...this.notes);
      out.push('');
    }

    // ---- hints
    const hints = this.hints({ frames, cpuAvg, wallAvg, gpuAvg, refreshMs, cpuScopes, gpuScopes, wallSorted, cpuSorted, secs });
    out.push('-- Hints --');
    if (hints.length) out.push(...hints.map((h) => `* ${h}`));
    else out.push('* nothing stands out');
    return out.join('\n');
  }

  /** Display refresh interval guess (ms): the fastest steady frame time snapped to a common refresh rate. */
  private estimateRefreshMs(wallSorted: number[]): number {
    if (!wallSorted.length) return 16.7;
    const fast = Math.max(2, percentile(wallSorted, 0.05));
    const hz = 1000 / fast;
    let best = REFRESH_RATES[0];
    for (const r of REFRESH_RATES) if (Math.abs(r - hz) < Math.abs(best - hz)) best = r;
    return 1000 / best;
  }

  private verdict(wall: number, cpu: number, gpu: number, refreshMs: number): { lines: string[]; kind: 'cpu' | 'gpu' | 'capped' | 'mixed' | 'unknown' } {
    const lines: string[] = [];
    const hz = Math.round(1000 / refreshMs);
    if (!wall || !cpu) return { lines: ['not enough frames recorded'], kind: 'unknown' };
    const hasGpu = Number.isFinite(gpu);
    lines.push(`display refresh ~${hz} Hz (${f1(refreshMs)} ms budget); wall ${f1(wall)} ms, cpu ${f1(cpu)} ms${hasGpu ? `, gpu ${f1(gpu)} ms` : ''}`);
    let kind: 'cpu' | 'gpu' | 'capped' | 'mixed' | 'unknown' = 'mixed';
    if (hasGpu && gpu > 0.8 * wall && gpu >= cpu) {
      kind = 'gpu';
      lines.push(`GPU-BOUND: GPU work (${f1(gpu)} ms) fills ${f1((100 * gpu) / wall)}% of the frame; CPU idles ${f1(Math.max(0, wall - cpu))} ms per frame.`);
    } else if (cpu > 0.8 * wall) {
      kind = 'cpu';
      lines.push(`CPU-BOUND (main thread): JS takes ${f1(cpu)} ms of a ${f1(wall)} ms frame (${f1((100 * cpu) / wall)}%)${hasGpu ? `, GPU only ${f1(gpu)} ms` : ''}.`);
    } else if (wall <= refreshMs * 1.15) {
      kind = 'capped';
      lines.push(`DISPLAY-CAPPED: frames arrive at the refresh rate. Headroom: CPU ${f1(refreshMs - cpu)} ms${hasGpu ? `, GPU ${f1(refreshMs - gpu)} ms` : ''} per frame.`);
    } else if (hasGpu) {
      lines.push(`MIXED / STALLS: wall ${f1(wall)} ms is longer than both CPU (${f1(cpu)}) and GPU (${f1(gpu)}). Look for vsync mismatches, compositor load, background tabs or thermal throttling.`);
    } else {
      kind = 'gpu';
      lines.push(`LIKELY GPU-BOUND: JS finishes in ${f1(cpu)} ms but the frame takes ${f1(wall)} ms (the CPU waits for the GPU). Exact GPU timings need the EXT_disjoint_timer_query_webgl2 extension.`);
    }
    return { lines, kind };
  }

  private hints(c: {
    frames: number; cpuAvg: number; wallAvg: number; gpuAvg: number; refreshMs: number;
    cpuScopes: Scope[]; gpuScopes: Scope[]; wallSorted: number[]; cpuSorted: number[]; secs: number;
  }): string[] {
    const hints: string[] = [];
    const { frames, cpuAvg, wallAvg, gpuAvg, refreshMs } = c;
    const per = (s: Scope) => s.sum / frames;
    const find = (cat: string, name?: string) => c.cpuScopes.filter((s) => s.cat === cat && (!name || s.name === name));
    const catSum = (cat: string) => find(cat).reduce((a, s) => a + per(s), 0);

    if (frames < 60) hints.push(`only ${frames} frames recorded: record at least 5-10 s for stable numbers`);

    // Stutter.
    const p50 = percentile(c.wallSorted, 0.5), p99 = percentile(c.wallSorted, 0.99);
    if (p50 > 0 && p99 > 2.5 * p50) {
      hints.push(`stutter: p99 frame time (${f1(p99)} ms) is ${f1(p99 / p50)}x the median (${f1(p50)} ms); see "Slowest frames" for the scope that spikes (shader compiles on first use, map building, GC, texture uploads)`);
    }
    const worst = this.worst[0];
    if (worst && p50 > 0 && worst.cpu > 3 * Math.max(percentile(c.cpuSorted, 0.5), 1) && worst.cpu > 25) {
      const spikes = this.worst.filter((w) => w.cpu > 3 * Math.max(percentile(c.cpuSorted, 0.5), 1) && w.cpu > 25).length;
      hints.push(`${spikes} frame(s) took over 3x the median CPU time; the worst (${f1(worst.cpu)} ms at t=${f1(worst.at)}s) was dominated by ${worst.top[0]?.[0] ?? '?'} (${f1(worst.top[0]?.[1] ?? 0)} ms)${worst.at < 3 ? '; early in the recording this is usually first-use shader compilation or texture upload' : ''}`);
    }
    if (this.heapSamples > 2) {
      const growth = this.heapMax - this.heapStart;
      if (growth > 150) hints.push(`JS heap grew ${f1(growth)} MB during the recording: allocation churn (GC pauses show up as spikes); look for per-frame temporary objects`);
    }

    // CPU side.
    const budget = refreshMs;
    for (const s of c.cpuScopes.sort((a, b) => b.sum - a.sum).slice(0, 3)) {
      if (per(s) > 0.25 * Math.max(cpuAvg, 1e-3) && per(s) > 1) hints.push(`CPU hot spot: ${s.cat}/${s.name} takes ${f2(per(s))} ms per frame (${f1((100 * per(s)) / Math.max(cpuAvg, 1e-3))}% of the main-thread frame)`);
    }
    const cull = catSum('cull');
    if (cull > 0.15 * budget) hints.push(`culling costs ${f2(cull)} ms per frame: fewer / larger chunk meshes, or skip the shadow-caster cull on frames where the camera and sun didn't move`);
    const build = catSum('build');
    if (build > 2) hints.push(`map building uses ${f2(build)} ms per frame of the main thread (BUILD_BUDGET_MS = 6): the recording overlaps a map load; record again once it finished for steady-state numbers`);
    if (catSum('gen') > 0) hints.push('the recording included map generation / event handling: steady-state numbers are best taken after loading');
    const update = catSum('update');
    if (update > 0.1 * budget) hints.push(`per-frame layer updates (uniforms, lamp levels) cost ${f2(update)} ms: only update when the value changed`);

    // GPU side.
    const groups = this.gpuGroups(c.gpuScopes);
    if (groups.length) {
      const gpuSum = groups.reduce((a, g) => a + g.sum, 0);
      const top = groups[0];
      if (gpuSum > 0) {
        hints.push(`most GPU time goes to "${top.name}": ${f2(top.sum / frames)} ms per frame (${f1((100 * top.sum) / gpuSum)}% of GPU time)${this.passAdvice(top.name)}`);
        // Detail mode: the most expensive parts of the biggest groups.
        for (const g of groups.slice(0, 3)) {
          const part = g.parts.slice().sort((a, b) => this.partCost(g, b) - this.partCost(g, a))[0];
          if (part && g.sum > 0.1 * gpuSum) {
            const name = part.name.slice(g.name.length + 2);
            const cost = this.partCost(g, part);
            hints.push(`within "${g.name}", "${name}" costs ${f2(cost / frames)} ms per frame (${f1((100 * cost) / g.sum)}% of it)${this.layerAdvice(name)}`);
          }
        }
      }
      const shadow = groups.find((g) => g.name.startsWith('shadow'));
      if (shadow && shadow.sum / frames > 0.2 * budget) hints.push(`shadow pass is ${f2(shadow.sum / frames)} ms per frame: smaller shadowMap or region, fewer / simpler casters (shadow proxies for far trees)`);
      const post = groups.filter((g) => /post|ambient|bloom|god|final|grade|lights|rays/.test(g.name)).reduce((a, g) => a + g.sum, 0);
      if (post > 0.5 * gpuSum && gpuSum / frames > 0.3 * budget) hints.push(`screen-space passes are ${f1((100 * post) / gpuSum)}% of GPU time: cost scales with resolution, so lower the quality's renderScale / pixelRatioCap first`);
    }
    // Post shader A/B (detail mode): the features that cost the most.
    const fullPost = c.gpuScopes.find((s) => s.name === POST_PASS);
    if (fullPost && fullPost.count > 0) {
      const fullAvg = fullPost.sum / fullPost.count;
      const costs = c.gpuScopes.filter((s) => s.name.startsWith(ABLATION) && s.count >= 5).map((s) => ({ name: s.name.slice(ABLATION.length), cost: fullAvg - s.sum / s.count })).sort((a, b) => b.cost - a.cost);
      if (costs.length && costs[0].cost > 0.15) hints.push(`post shader: "${costs[0].name}" is the costliest feature (~${f2(costs[0].cost)} ms per frame, ${f1((100 * costs[0].cost) / Math.max(1e-3, fullAvg))}% of the pass)`);
    }

    // Counters.
    const calls = this.counterAvg('draw calls', 'scene (HDR)');
    if (calls !== null && calls > 1500) hints.push(`the main scene issues ~${Math.round(calls)} draw calls: CPU submit cost grows with it; merge far chunks, increase CHUNK_CELLS for distant LODs, or instance more`);
    const shadowCalls = this.counterAvg('draw calls', 'shadow map');
    if (shadowCalls !== null && shadowCalls > 800) hints.push(`the shadow pass issues ~${Math.round(shadowCalls)} draw calls: cull casters harder (only chunks inside the region) or merge casters`);
    const tris = this.counterAvg('triangles', 'scene (HDR)');
    if (tris !== null && tris > 3_000_000) hints.push(`the main scene draws ~${(tris / 1e6).toFixed(1)} M triangles: vertex-bound risk on weak GPUs; check terrain / tree / building LOD distances`);
    if (wallAvg > 0 && cpuAvg > 0 && wallAvg > 1.5 * refreshMs && Number.isFinite(gpuAvg) && gpuAvg < 0.5 * wallAvg && cpuAvg < 0.5 * wallAvg) hints.push('neither CPU nor GPU fill the frame: suspect vsync / compositor / power saving (is the tab visible and the GPU in high-performance mode?)');
    return hints;
  }

  /** GPU scopes grouped by pass: `<group>: <part>` scopes belong to `<group>` (ablation probes are left out). */
  private gpuGroups(scopes: Scope[]): GpuGroup[] {
    const map = new Map<string, GpuGroup>();
    for (const s of scopes) {
      if (s.name.startsWith(ABLATION)) continue;
      const i = s.name.indexOf(': ');
      const name = i > 0 ? s.name.slice(0, i) : s.name;
      let g = map.get(name);
      if (!g) map.set(name, (g = { name, sum: 0, parts: [], single: null, overhead: 0, overheadScope: null }));
      g.sum += s.sum;
      if (i > 0) g.parts.push(s);
      else g.single = s;
    }
    for (const g of map.values()) {
      g.parts.sort((a, b) => b.sum - a.sum);
      // Detail mode: every layer is a separate render with its own overhead (MSAA resolve...); the empty render measures it.
      // Take it out of the group total (one render's worth stays: a normal frame pays it once).
      const oh = g.parts.find((p) => p.name.endsWith(OVERHEAD));
      if (oh && oh.count > 0) {
        g.overhead = oh.sum / oh.count;
        const others = g.parts.filter((p) => p !== oh);
        const calls = others.reduce((a, p) => a + p.count, 0);
        g.sum = Math.max(0, others.reduce((a, p) => a + p.sum, 0) - g.overhead * Math.max(0, calls - oh.count));
        g.parts = others;
        g.overheadScope = oh;
      }
    }
    return [...map.values()].sort((a, b) => b.sum - a.sum);
  }

  /** GPU time of a part with its group's per-render overhead taken out (ms, total over the recording). */
  private partCost(g: GpuGroup, p: Scope): number {
    return Math.max(0, p.sum - g.overhead * p.count);
  }

  /** Average per-sample value of a counter, or the sum of the averages of its `<name>: <part>` counters. */
  private counterAvg(kind: string, name: string): number | null {
    const own = this.counters.get(`${kind}\u0000${name}`);
    if (own) return own.sum / own.count;
    return this.groupCounter(kind, name);
  }

  private groupCounter(kind: string, group: string): number | null {
    let total = 0;
    let found = false;
    const prefix = `${kind}\u0000${group}: `;
    for (const [key, s] of this.counters) {
      if (key.startsWith(prefix)) {
        total += s.sum / s.count;
        found = true;
      }
    }
    return found ? total : null;
  }

  private layerAdvice(name: string): string {
    if (name.startsWith('terrain')) return ': terrain shader texture taps, LOD distances (terrainLodScale), anisotropy';
    if (name.startsWith('trees')) return ': tree instances / sprite distance (spriteDistance), overdraw of canopies';
    if (name.startsWith('rocks')) return ': rock instances / sprite distance';
    if (name.startsWith('buildings')) return ': building near / far meshes (buildingDistance), window shaders';
    if (name.startsWith('roads')) return ': road ribbon shader (paint, rail) and overdraw on wide junction plates';
    if (name.startsWith('sky')) return ': sky shader (stars, atmosphere taps)';
    if (name.startsWith('light halos')) return ': halo overdraw (many additive discs), bokeh size';
    if (name.startsWith('urban')) return ': decals / cars / signals (lodMax)';
    if (name.startsWith('street lights')) return ': lamp instances (lightDistance)';
    return '';
  }

  private passAdvice(name: string): string {
    if (name.startsWith('scene')) return ': overdraw / shader cost of the map shaders: check terrain / water shader taps, fog LUT taps, texture anisotropy';
    if (name.startsWith('shadow')) return ': see the shadow hints';
    if (name.includes('ao')) return ': aoSamples / AO resolution';
    if (name.includes('bloom')) return ': bloomLevels';
    if (name.includes('god')) return ': godRays (ultra only)';
    if (name.includes('light')) return ': deferred light volumes / overdraw of big light radii; lightDistance';
    if (name.includes('ray')) return ': lightShafts / reflections';
    if (name.includes('post')) return ': the post shader (shadow taps, contact steps)';
    if (name.includes('final')) return ': FXAA / tilt-shift / sharpen taps';
    return '';
  }
}

/** The shared profiler instance every module records into. */
export const profiler = new Profiler();
