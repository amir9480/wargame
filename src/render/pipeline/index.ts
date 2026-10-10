// Render pipeline: turns the generator's event stream into meshes. Events are handled as they arrive (data is
// stored, jobs are queued, see stages.ts); `update` runs queued jobs within a per-frame time budget, nearest the
// camera first, so the map builds up visibly while the page stays responsive.

import type * as THREE from 'three';
import type { GenEvent, Terrain, TerrainMeta } from '../../terrain/generate.ts';
import { ChunkGrid } from '../culling.ts';
import { JobQueue } from './queue.ts';
import { RENDER_STAGES, type RenderContext, type RenderLayers } from './stages.ts';

export type { RenderLayers } from './stages.ts';

export class RenderPipeline {
  private layers: RenderLayers;
  private queue = new JobQueue();
  private ctx: RenderContext | null = null;
  private complete = false;
  /** Something changed outside a job (a new map started): the scene needs a re-sync. */
  private changed = false;
  private built: Promise<void> = Promise.resolve();
  private resolveBuilt: () => void = () => {};

  constructor(layers: RenderLayers) {
    this.layers = layers;
  }

  /** The map being built (partial until `done`), or null before the first map. */
  get map(): Terrain | null {
    return this.ctx?.map ?? null;
  }

  /** The finished map, once every stage is built. */
  get terrain(): Terrain | null {
    return this.complete ? this.map : null;
  }

  /** Queued build jobs. */
  get pending(): number {
    return this.queue.size;
  }

  /** Resolves when the current map is fully built (all events handled, every job run). */
  whenBuilt(): Promise<void> {
    return this.built;
  }

  /** Handles one generator event (in pipeline order). A `meta` event starts a new map and drops the old one. */
  push(event: GenEvent): void {
    if (event.kind === 'meta') {
      this.begin(event.meta);
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const handler = RENDER_STAGES[event.kind] as ((e: GenEvent, c: RenderContext) => void) | undefined;
    handler?.(event, ctx);
  }

  /** Feeds a complete map through the pipeline and builds it at once. */
  load(terrain: Terrain): void {
    const N = terrain.size;
    this.push({ kind: 'meta', meta: terrain });
    this.push({ kind: 'heights', j0: 0, j1: N, data: terrain.heights });
    this.push({ kind: 'rivers', rivers: terrain.rivers });
    this.push({ kind: 'bases', bases: terrain.bases });
    this.push({ kind: 'cities', cities: terrain.cities });
    this.push({ kind: 'roads', roads: terrain.roads });
    this.push({ kind: 'buildings', buildings: terrain.buildings, parking: terrain.parking });
    this.push({ kind: 'landmarks', lighthouses: terrain.lighthouses, towers: terrain.towers });
    this.push({ kind: 'cover', j0: 0, j1: N, data: terrain.dirt });
    this.push({ kind: 'rocks', rocks: terrain.rocks });
    this.push({ kind: 'trees', type: terrain.trees.type, trees: terrain.trees.trees });
    this.push({ kind: 'done', terrain });
  }

  /** Runs queued jobs for about `budgetMs` (at least one). Returns true when the scene changed. */
  update(budgetMs: number, focus: THREE.Vector3): boolean {
    const ran = this.queue.size ? this.queue.run(budgetMs, focus) : 0;
    const changed = this.changed || ran > 0;
    this.changed = false;
    return changed;
  }

  private begin(meta: TerrainMeta): void {
    const N = meta.size;
    const map: Terrain = {
      ...meta,
      heights: new Float32Array(N * N),
      rivers: [],
      bases: [],
      roads: { nodes: [], edges: [] },
      cities: [],
      buildings: [],
      parking: [],
      lighthouses: [],
      towers: [],
      rocks: [],
      dirt: new Float32Array(N * N),
      mountain: new Float32Array(N * N),
      trees: { type: 'pine', trees: [] },
      landRatio: 0,
    };
    const grid = new ChunkGrid(map.worldSize, map.cell);
    const { ground, rocks, trees, roads, bases, streetLights, buildings, urban, landmarks, lights } = this.layers;
    this.queue.clear();
    lights.setWetMask(null, 1); // no reflections until the new map's mask is built
    ground.begin(map, grid);
    rocks.begin(map.seed);
    trees.begin(map.seed);
    roads.clear();
    bases.clear();
    streetLights.clear();
    buildings.clear();
    urban.clear();
    landmarks.clear();

    this.resolveBuilt(); // an abandoned map counts as done for whoever waited on it
    this.built = new Promise((resolve) => (this.resolveBuilt = resolve));
    this.complete = false;
    this.changed = true;
    this.ctx = {
      map,
      grid,
      layers: this.layers,
      queue: this.queue,
      bands: 0,
      finish: () => {
        this.complete = true;
        this.resolveBuilt();
      },
    };
  }
}
