// Web Worker running the generator pipeline off the main thread: every pipeline event is posted as soon as it
// is ready, so the renderer can show the map while the rest is still being generated.

import { runPipeline } from './pipeline/run.ts';
import { fetchMountainLibrary, type MountainLibrary } from './mountains/library.ts';
import type { GenEvent, TerrainOptions } from './pipeline/types.ts';

export interface GenRequest {
  id: number;
  seed: number;
  options: TerrainOptions;
  /** Absolute URL of the mountain heightmap folder (ends with '/'). */
  heightmapUrl: string;
}

export type GenResponse =
  | { id: number; event: GenEvent }
  /** Pipeline run time (ms), sent right after `done`. */
  | { id: number; ms: number }
  | { id: number; error: string };

interface WorkerScope {
  onmessage: ((e: MessageEvent<GenRequest>) => void) | null;
  postMessage(message: GenResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

// Real mountain heightmaps, fetched once with the first job (the URL comes with the request).
let library: Promise<MountainLibrary> | null = null;

scope.onmessage = async ({ data: { id, seed, options, heightmapUrl } }) => {
  try {
    library ??= fetchMountainLibrary(heightmapUrl).catch((err) => {
      library = null; // try again with the next job
      throw err;
    });
    const mountains = await library;
    const t0 = performance.now();
    for (const event of runPipeline(seed, mountains, options)) scope.postMessage({ id, event }, transferables(event));
    scope.postMessage({ id, ms: performance.now() - t0 });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
};

/** Buffers handed over instead of copied: row slices are fresh copies and the finished map is not reused here. */
function transferables(event: GenEvent): Transferable[] {
  switch (event.kind) {
    case 'heights':
    case 'cover':
      return [event.data.buffer];
    case 'done': {
      const { heights, dirt, mountain } = event.terrain;
      return [heights.buffer, dirt.buffer, mountain.buffer];
    }
    default:
      return [];
  }
}
