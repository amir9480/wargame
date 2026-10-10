// GPU pass timing for the profiler (core/profiler.ts `GpuProbe`) with EXT_disjoint_timer_query_webgl2. Queries are
// asynchronous: a result is read a few frames after the pass, tagged with the frame it belonged to. Queries cannot
// nest (the profiler only opens the outermost pass). Unsupported browsers / GPUs report `supported = false`.

import type { GpuProbe } from '../core/profiler.ts';

/** Queries in flight at most (older results are dropped when the GPU lags far behind). */
const MAX_PENDING = 96;

interface Pending {
  query: WebGLQuery;
  name: string;
  frame: number;
}

interface DisjointTimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer implements GpuProbe {
  readonly supported: boolean;
  private gl: WebGL2RenderingContext;
  private ext: DisjointTimerExt | null;
  private pending: Pending[] = [];
  private free: WebGLQuery[] = [];
  private active: Pending | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerExt | null;
    this.supported = this.ext !== null;
  }

  /** Name of the GPU for the report (needs WEBGL_debug_renderer_info, may be masked by the browser). */
  gpuName(): string {
    const info = this.gl.getExtension('WEBGL_debug_renderer_info');
    if (!info) return 'unknown';
    return String(this.gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  }

  begin(name: string, frame: number): void {
    if (!this.ext || this.active || this.pending.length >= MAX_PENDING) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { query, name, frame };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Forgets queries still in flight (a new recording starts: their frame numbers no longer fit). */
  reset(): void {
    for (const p of this.pending) this.free.push(p.query);
    this.pending = [];
  }

  poll(sink: (name: string, ms: number, frame: number) => void): void {
    const { gl, ext } = this;
    if (!ext || !this.pending.length) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break; // results come back in order
      this.pending.shift();
      if (!disjoint) sink(p.name, (gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number) / 1e6, p.frame);
      this.free.push(p.query);
    }
  }
}
