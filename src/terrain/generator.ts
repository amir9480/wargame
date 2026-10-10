// Main-thread side of map generation: runs the generator pipeline in a Web Worker and hands every event to
// the caller as it arrives. Without worker support the pipeline runs here instead, one event per macrotask,
// so the page still renders between pieces.

import { runPipeline } from './pipeline/run.ts';
import { fetchMountainLibrary, type MountainLibrary } from './mountains/library.ts';
import type { GenEvent, Terrain, TerrainOptions } from './pipeline/types.ts';
import type { GenRequest, GenResponse } from './worker.ts';

/** Mountain heightmaps (scripts/fetch-heightmaps.ts), absolute so the worker resolves it the same way. */
const HEIGHTMAP_URL = new URL(`${import.meta.env.BASE_URL}assets/heightmaps/`, location.href).href;

export interface GenResult {
  terrain: Terrain;
  /** Pipeline run time in ms (excluding waits between events on the main-thread fallback). */
  ms: number;
}

export class TerrainGenerator {
  private worker: Worker | null = null;
  private job = 0;
  /** Mountain heightmaps for the main-thread fallback (the worker loads its own). */
  private library: Promise<MountainLibrary> | null = null;

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.warn('Terrain worker unavailable, generating on the main thread', err);
    }
  }

  /** Generates a map, calling `onEvent` for every pipeline event in order. A newer call abandons an older one. */
  generate(seed: number, options: TerrainOptions, onEvent: (event: GenEvent) => void): Promise<GenResult> {
    const id = ++this.job;
    const worker = this.worker;
    if (!worker) return this.generateHere(id, seed, options, onEvent);

    return new Promise((resolve, reject) => {
      let terrain: Terrain | null = null;
      const onMessage = ({ data }: MessageEvent<GenResponse>) => {
        if (data.id !== id) return; // reply to an abandoned job
        if ('error' in data) {
          finish();
          reject(new Error(data.error));
        } else if ('ms' in data) {
          finish();
          if (terrain) resolve({ terrain, ms: data.ms });
          else reject(new Error('Terrain worker finished without a map'));
        } else {
          if (data.event.kind === 'done') terrain = data.event.terrain;
          onEvent(data.event);
        }
      };
      const onError = (e: ErrorEvent) => {
        finish();
        reject(new Error(e.message || 'Terrain worker failed'));
      };
      const finish = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, seed, options, heightmapUrl: HEIGHTMAP_URL } satisfies GenRequest);
    });
  }

  private async generateHere(id: number, seed: number, options: TerrainOptions, onEvent: (event: GenEvent) => void): Promise<GenResult> {
    this.library ??= fetchMountainLibrary(HEIGHTMAP_URL).catch((err) => {
      this.library = null;
      throw err;
    });
    const run = runPipeline(seed, await this.library, options);
    let ms = 0;
    for (;;) {
      const t0 = performance.now();
      const step = run.next();
      ms += performance.now() - t0;
      if (step.done) return { terrain: step.value, ms };
      if (id !== this.job) throw new Error('Generation superseded');
      onEvent(step.value);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}
