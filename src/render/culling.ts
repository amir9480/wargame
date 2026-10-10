// View-frustum culling by spatial chunk.
//
// Three.js only culls whole objects (by bounding sphere). Our map-wide meshes
// (terrain, all trees, all rocks...) would therefore always be drawn in full.
// Instead every layer splits its content into chunks of the map; each chunk is
// its own mesh with a tight world-space bounding box, and the Culler hides the
// ones outside the camera frustum once per frame. Testing a few hundred boxes is
// far cheaper than testing thousands of individual trees / rocks.

import * as THREE from 'three';

/** Map chunk size in grid cells. */
export const CHUNK_CELLS = 32;

/** Square grid of chunks covering the map (centred on the origin). */
export class ChunkGrid {
  /** Chunks per map side. */
  readonly count: number;
  readonly chunkSize: number;
  private half: number;

  constructor(worldSize: number, cell: number, chunkCells = CHUNK_CELLS) {
    this.chunkSize = chunkCells * cell;
    this.count = Math.ceil(worldSize / this.chunkSize);
    this.half = worldSize / 2;
  }

  /** World-space centre (y = 0) of chunk `key`; the common reference for LOD distances. */
  center(key: number, out = new THREE.Vector3()): THREE.Vector3 {
    const n = this.count;
    return out.set(((key % n) + 0.5) * this.chunkSize - this.half, 0, (Math.floor(key / n) + 0.5) * this.chunkSize - this.half);
  }

  /** Chunk id containing world position (x, z); positions outside clamp to the border chunks. */
  key(x: number, z: number): number {
    const n = this.count;
    const cx = Math.min(n - 1, Math.max(0, Math.floor((x + this.half) / this.chunkSize)));
    const cz = Math.min(n - 1, Math.max(0, Math.floor((z + this.half) / this.chunkSize)));
    return cz * n + cx;
  }
}

/** Groups items by the chunk their position falls in. */
export function groupByChunk<T extends { x: number; z: number }>(items: T[], grid: ChunkGrid): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const it of items) {
    const k = grid.key(it.x, it.z);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(it);
  }
  return out;
}

/**
 * Splits a geometry (world-space positions) into one geometry per chunk, assigning
 * each triangle by its centroid. All attributes are carried over; the result is indexed.
 */
export function splitByChunk(geo: THREE.BufferGeometry, grid: ChunkGrid): THREE.BufferGeometry[] {
  const pos = geo.attributes.position;
  const index = geo.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const vert = (t: number, c: number) => (index ? index.getX(t * 3 + c) : t * 3 + c);

  const buckets = new Map<number, number[]>(); // chunk -> triangle ids
  for (let t = 0; t < triCount; t++) {
    const a = vert(t, 0), b = vert(t, 1), c = vert(t, 2);
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const k = grid.key(x, z);
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(t);
  }

  const names = Object.keys(geo.attributes);
  const out: THREE.BufferGeometry[] = [];
  for (const tris of buckets.values()) {
    const remap = new Map<number, number>();
    const newIndex: number[] = [];
    for (const t of tris) {
      for (let c = 0; c < 3; c++) {
        const v = vert(t, c);
        let nv = remap.get(v);
        if (nv === undefined) remap.set(v, (nv = remap.size));
        newIndex.push(nv);
      }
    }
    const part = new THREE.BufferGeometry();
    for (const name of names) {
      const src = geo.attributes[name] as THREE.BufferAttribute;
      const size = src.itemSize;
      const data = new Float32Array(remap.size * size);
      for (const [v, nv] of remap) for (let s = 0; s < size; s++) data[nv * size + s] = src.array[v * size + s];
      part.setAttribute(name, new THREE.BufferAttribute(data, size));
    }
    part.setIndex(newIndex);
    out.push(part);
  }
  return out;
}

export interface CullStats {
  drawn: number;
  total: number;
}

interface CullItem {
  object: THREE.Object3D;
  box: THREE.Box3;
  center: THREE.Vector3;
  /** `object.userData` (read every frame: lodMin / lodMax / lodCenter / lodBlend / shadowOnly can change). */
  data: Record<string, any>;
}

/** Items are bucketed by the ground cell (m) their box centre is in; a bucket is frustum-tested once, then its items. */
const BUCKET_SIZE = 64;

interface Bucket {
  box: THREE.Box3;
  items: CullItem[];
}

/** Per-frame frustum test of registered objects against their world-space boxes. */
export class Culler {
  private items: CullItem[] = [];
  /** Items grouped by ground cell: a whole cell outside the frustum is skipped with one box test. */
  private buckets: Bucket[] = [];
  private frustum = new THREE.Frustum();
  private viewProj = new THREE.Matrix4();
  /** Objects the last `update` made visible, and a scratch list for the next one; `userData.cullStamp` = call that showed it. */
  private shown: THREE.Object3D[] = [];
  private spare: THREE.Object3D[] = [];
  private stamp = 0;

  /** Regroups the items into ground buckets (after the item list changed). */
  private regroup(): void {
    const map = new Map<number, Bucket>();
    for (const it of this.items) {
      const key = Math.floor(it.center.x / BUCKET_SIZE) * 4096 + Math.floor(it.center.z / BUCKET_SIZE);
      let b = map.get(key);
      if (!b) map.set(key, (b = { box: new THREE.Box3(), items: [] }));
      b.items.push(it);
      b.box.union(it.box);
    }
    this.buckets = [...map.values()];
  }

  /**
   * Registers every mesh under `root` (unless `userData.noCull`), taking over from
   * three.js' own per-object sphere test. Meshes must have identity transforms
   * relative to the world (true for all generated map content).
   * Meshes with `userData.lodMin` / `lodMax` are also shown only while the camera
   * is within [lodMin, lodMax) of `userData.lodCenter` (default: box centre), so
   * the LOD variants of one chunk must share a lodCenter to switch exactly once.
   */
  collect(root: THREE.Object3D, margin = 0): void {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && !o.userData.noCull) this.items.push(this.item(o, margin));
    });
    this.regroup();
  }

  /**
   * Brings the registered set in line with what is under `root` now (for content that is built piece by piece):
   * new meshes are added, removed ones dropped, and meshes flagged `userData.boundsDirty` (geometry rewritten) get a new box.
   */
  sync(root: THREE.Object3D, margin = 0): void {
    const known = new Map(this.items.map((it) => [it.object, it]));
    this.items = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.noCull) return;
      const it = known.get(o);
      if (it && !o.userData.boundsDirty) this.items.push(it);
      else this.items.push(this.item(o, margin));
    });
    this.regroup();
  }

  private item(o: THREE.Mesh, margin: number): CullItem {
    let box: THREE.Box3;
    if (o instanceof THREE.InstancedMesh) {
      o.computeBoundingBox();
      box = o.boundingBox!.clone();
    } else {
      o.geometry.computeBoundingBox();
      box = o.geometry.boundingBox!.clone();
    }
    box.expandByScalar(margin);
    o.frustumCulled = false;
    o.userData.boundsDirty = false;
    o.visible = false; // shown by the next `update` if in view (the update hides only what it showed before)
    return { object: o, box, center: box.getCenter(new THREE.Vector3()), data: o.userData };
  }

  clear(): void {
    this.items = [];
    this.buckets = [];
  }

  /**
   * `camera` supplies the frustum, `lodCamera` (default: `camera`) the reference point for LOD distances. A shadow-map
   * pass culls with the light's frustum (casters off screen still cast) but picks levels from the main camera, so every
   * object casts with the level the view draws. `userData.shadowOnly` meshes (low-poly casters standing in for sprites)
   * are drawn in shadow passes only.
   */
  update(camera: THREE.Camera, lodCamera: THREE.Object3D = camera, shadowPass = false): CullStats {
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    // Only items in a bucket the frustum touches are tested; items shown by the previous call that are not shown now
    // are hidden at the end (no pass over every item). Stamp = this call; items start hidden (`item`).
    const stamp = ++this.stamp;
    const shown = this.spare;
    shown.length = 0;
    const cam = lodCamera.position;
    let drawn = 0;
    for (const bucket of this.buckets) {
      if (!this.frustum.intersectsBox(bucket.box)) continue;
      for (const { object, box, center, data } of bucket.items) {
        if (data.shadowOnly && !shadowPass) continue;
        // A shadow pass may switch levels at other distances than the view (`shadowLodMin / Max`): e.g. a tree's full mesh
        // only casts near the camera, a low-poly stand-in takes over sooner than the sprite does in the view.
        const lodMin = shadowPass ? data.shadowLodMin ?? data.lodMin : data.lodMin;
        const lodMax = shadowPass ? data.shadowLodMax ?? data.lodMax : data.lodMax;
        if (lodMin !== undefined || lodMax !== undefined) {
          const c = data.lodCenter ?? center;
          const dx = cam.x - c.x, dy = cam.y - c.y, dz = cam.z - c.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          // `lodBlend`: the shader of a mesh decides per instance near the limits, so the chunk test is wider (not in shadow passes).
          const blend = shadowPass ? 0 : data.lodBlend ?? 0;
          const lo = (lodMin ?? 0) - blend;
          const hi = (lodMax ?? Infinity) + blend;
          if (lo > 0 && d2 < lo * lo) continue;
          if (hi < Infinity) {
            // `lodMaxCenter`: the far limit is measured from another point (a merged mesh that takes over from several
            // chunks switches on at one distance, so those chunks must switch off by that same distance).
            let dMax2 = d2;
            const cm = data.lodMaxCenter;
            if (cm) {
              const mx = cam.x - cm.x, my = cam.y - cm.y, mz = cam.z - cm.z;
              dMax2 = mx * mx + my * my + mz * mz;
            }
            if (dMax2 >= hi * hi) continue;
          }
        }
        if (!this.frustum.intersectsBox(box)) continue;
        object.visible = true;
        data.cullStamp = stamp;
        shown.push(object);
        drawn++;
      }
    }
    for (const object of this.shown) if (object.userData.cullStamp !== stamp) object.visible = false;
    this.spare = this.shown;
    this.shown = shown;
    return { drawn, total: this.items.length };
  }
}
