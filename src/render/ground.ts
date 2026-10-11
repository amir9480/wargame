// Ground layer: terrain chunk meshes (3 detail levels each), the water plane, the map-edge skirt and the data
// textures the ground shaders read (half-float heights, RG8 cover). Built while the map streams in: heights
// arrive in row bands / whole-grid snapshots, and only the chunks whose heights changed are (re)built, each
// as its own small job. Chunk geometries keep their topology, so later height updates rewrite them in place.

import * as THREE from 'three';
import { SNOW_LINE, type River, type Terrain, type Tree } from '../terrain/generate.ts';
import terrainVertex from './shaders/terrain.vert.glsl';
import terrainFragment from './shaders/terrain.frag.glsl';
import waterVertex from './shaders/water.vert.glsl';
import waterFragment from './shaders/water.frag.glsl';
import skirtVertex from './shaders/skirt.vert.glsl';
import skirtFragment from './shaders/skirt.frag.glsl';
import { CHUNK_CELLS, splitByChunk, type ChunkGrid } from './culling.ts';
import type { Environment, TerrainTextures } from './world.ts';

const SKIRT_BOTTOM = -40;
/** Outward lean of chunk skirts, in metres. */
const SKIRT_FLARE = 1;
/** Stream ribbons reach this far (m) beyond the channel on each side; hidden beyond STREAM_DISTANCE camera distance. */
const STREAM_MARGIN = 0.8;
const STREAM_DISTANCE = 900;
/** Ground this close above the water level (m) still counts as wet when deciding which chunks get a water quad. */
const WET_MARGIN = 0.3;
/** Per-chunk terrain detail levels: grid step (cells between vertices) and the camera distance up to which each is used. */
const TERRAIN_LODS = [
  { step: 1, maxDist: 260 },
  { step: 2, maxDist: 520 },
];
/**
 * Far terrain: `SUPER_CHUNKS` x `SUPER_CHUNKS` chunks drawn as one mesh (a few draw calls instead of hundreds). A level is used
 * from `minDist` to `maxDist` camera distance to the super chunk's centre; the chunks' last level is switched off by that same
 * distance (`lodMaxCenter`), so there is neither a gap nor an overlap. A super chunk exists once all its chunks are built.
 */
const SUPER_CHUNKS = 4;
const SUPER_LODS = [
  { step: 4, minDist: 520, maxDist: 1000 },
  { step: 8, minDist: 1000, maxDist: Infinity },
];

/** The rendered height field (the whole generated grid, play area plus surroundings). */
export type Ground = Pick<Terrain, 'size' | 'cell' | 'worldSize' | 'waterLevel' | 'heightScale' | 'heights'>;

interface ChunkLod {
  mesh: THREE.Mesh;
  level: number;
  /** Rewrites heights, normals and skirt drops from the current heightmap. */
  fill(): void;
}

interface SuperChunk {
  center: THREE.Vector3;
  /** Chunk keys it replaces at a distance. */
  keys: number[];
  levels: ChunkLod[];
}

export class GroundLayer {
  readonly group = new THREE.Group();
  readonly terrainMat: THREE.ShaderMaterial;
  readonly waterMat: THREE.ShaderMaterial;
  readonly streamMat: THREE.ShaderMaterial;
  /** Map-edge walls; fogged like the terrain (fog uniforms are driven by `World.update`). */
  readonly skirtMat: THREE.ShaderMaterial;
  private ground: Ground | null = null;
  private grid: ChunkGrid | null = null;
  /** Chunk key -> its detail levels. */
  private chunks = new Map<number, ChunkLod[]>();
  /** Super chunk key -> its far meshes (only complete ones). */
  private supers = new Map<number, SuperChunk>();
  /** Super chunks with a changed chunk, waiting for `flushSupers`. */
  private dirtySupers = new Set<number>();
  /** Chunk key -> its water quad (x0, z0, x1, z1; only chunks with wet ground). All quads are drawn as ONE mesh (`waterMesh`). */
  private waters = new Map<number, [number, number, number, number]>();
  private waterMesh: THREE.Mesh | null = null;
  private edge: THREE.Mesh[] = [];
  private heightTex: THREE.DataTexture | null = null;
  private coverTex: THREE.DataTexture | null = null;
  private canopy = new Float32Array(0);
  private lodScale = 1;

  constructor(textures: TerrainTextures, env: Environment) {
    this.terrainMat = new THREE.ShaderMaterial({
      vertexShader: terrainVertex,
      fragmentShader: terrainFragment,
      uniforms: {
        tGrass: { value: textures.grass },
        tSand: { value: textures.sand },
        tRock: { value: textures.rock },
        tSnow: { value: textures.snow },
        tDirt: { value: textures.dirt },
        sunDir: { value: env.sunDir },
        sunColor: { value: env.sunColor },
        skyAmbient: { value: env.skyAmbient },
        groundAmbient: { value: env.groundAmbient },
        ...env.fog,
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
        waterLevel: { value: 0 },
        snowLine: { value: SNOW_LINE },
        heightScale: { value: 1 },
        tCover: { value: null },
        mapSize: { value: 1 },
        gridSize: { value: 1 },
      },
    });

    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      transparent: true,
      // Writes depth so the lighting pass (shadows, AO, normals from depth) shades the flat water surface,
      // not the faceted river bed seen through it.
      depthWrite: true,
      uniforms: {
        tNormal: { value: textures.waterNormal },
        tHeight: { value: null },
        time: { value: 0 },
        waterLevel: { value: 0 },
        mapSize: { value: 1 },
        gridSize: { value: 1 },
        sunDir: { value: env.sunDir },
        sunColor: { value: env.sunColor },
        daylight: env.daylight,
        shallowColor: { value: new THREE.Color(0x34504d) },
        deepColor: { value: new THREE.Color(0x111f26) },
        ...env.fog,
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
      },
    });

    // Mountain streams: the water shader on ribbons at their own surface height (same uniform objects as the water).
    this.streamMat = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      defines: { STREAM: '' },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      uniforms: this.waterMat.uniforms,
    });

    this.skirtMat = new THREE.ShaderMaterial({
      vertexShader: skirtVertex,
      fragmentShader: skirtFragment,
      vertexColors: true,
      side: THREE.DoubleSide,
      uniforms: { ...env.fog, fogNear: { value: 400 }, fogFar: { value: 1200 } },
    });
  }

  get heightTexture(): THREE.DataTexture | null {
    return this.heightTex;
  }

  /**
   * Starts a new map: flat ground (all heights 0 until they stream in), plain grass cover, the water plane.
   * `ground.heights` is the live heightmap; `applyHeights` writes into it.
   */
  begin(ground: Ground, grid: ChunkGrid): void {
    this.clear();
    this.ground = ground;
    this.grid = grid;
    const N = ground.size;
    this.canopy = new Float32Array(N * N);

    this.heightTex = dataTexture(new Uint16Array(N * N), N, THREE.RedFormat, THREE.HalfFloatType);
    this.coverTex = dataTexture(new Uint8Array(N * N * 2), N, THREE.RGFormat, THREE.UnsignedByteType);
    const tu = this.terrainMat.uniforms;
    tu.waterLevel.value = ground.waterLevel;
    // Height-based looks (snow line, bare rock on high ground) follow the mountains' vertical scale.
    tu.heightScale.value = ground.heightScale;
    tu.snowLine.value = SNOW_LINE * ground.heightScale;
    tu.tCover.value = this.coverTex;
    tu.mapSize.value = ground.worldSize;
    tu.gridSize.value = N;

    // Water is one flat quad per terrain chunk that has wet ground (see `updateWater`), all merged into a single mesh.
    const wu = this.waterMat.uniforms;
    wu.tHeight.value = this.heightTex;
    wu.waterLevel.value = ground.waterLevel;
    wu.mapSize.value = ground.worldSize;
    wu.gridSize.value = N;
  }

  /** Adds / removes / keeps the water quad of chunk `key` (grid bounds i0..i1, j0..j1) depending on whether any ground there is wet. */
  private updateWater(key: number, i0: number, j0: number, i1: number, j1: number): void {
    const g = this.ground!;
    const { size: N, heights } = g;
    const limit = g.waterLevel + WET_MARGIN;
    let wet = false;
    // One cell beyond the chunk: the quad's shoreline pixels read the height texture with bilinear filtering.
    for (let j = Math.max(0, j0 - 1); j <= Math.min(N - 1, j1 + 1) && !wet; j++)
      for (let i = Math.max(0, i0 - 1); i <= Math.min(N - 1, i1 + 1); i++)
        if (heights[j * N + i] < limit) {
          wet = true;
          break;
        }
    const existing = this.waters.get(key);
    if (!wet) {
      if (existing) {
        this.waters.delete(key);
        this.rebuildWater();
      }
      return;
    }
    if (existing) return;
    const half = g.worldSize / 2;
    this.waters.set(key, [-half + i0 * g.cell, -half + j0 * g.cell, -half + i1 * g.cell, -half + j1 * g.cell]);
    this.rebuildWater();
  }

  /**
   * All water quads in one mesh (one draw call instead of one per wet chunk). It is never culled by the Culler: the quads
   * are flat and cheap, and the GPU clips what is off screen.
   */
  private rebuildWater(): void {
    const y = this.ground!.waterLevel;
    const quads = [...this.waters.values()];
    const pos = new Float32Array(quads.length * 12);
    const index = new Uint32Array(quads.length * 6);
    quads.forEach(([x0, z0, x1, z1], q) => {
      pos.set([x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1], q * 12);
      index.set([0, 2, 1, 1, 2, 3].map((v) => v + q * 4), q * 6); // faces up
    });
    if (this.waterMesh) {
      this.waterMesh.geometry.dispose();
      this.group.remove(this.waterMesh);
      this.waterMesh = null;
    }
    if (!quads.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(geo, this.waterMat);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    mesh.userData.noShadow = true;
    mesh.userData.noCull = true;
    this.waterMesh = mesh;
    this.group.add(mesh);
  }

  /**
   * Writes heights for rows j0..j1-1 into the live heightmap and the height texture.
   * Returns the chunks whose surface changed (to rebuild with `buildChunk`) and whether the map edge did (`buildEdge`).
   */
  applyHeights(j0: number, j1: number, data: Float32Array): { chunks: Set<number>; edge: boolean } {
    const chunks = new Set<number>();
    let edge = false;
    const g = this.ground;
    if (!g || !this.heightTex) return { chunks, edge };
    const N = g.size;
    const { heights } = g;
    const tex = this.heightTex.image.data as Uint16Array;
    const last = Math.ceil((N - 1) / CHUNK_CELLS) - 1;
    // Chunk c spans vertices c*C .. c*C + C and reads one more on each side for normals.
    const lo = (a: number) => Math.max(0, Math.ceil((a - CHUNK_CELLS - 1) / CHUNK_CELLS));
    const hi = (a: number) => Math.min(last, Math.floor((a + 1) / CHUNK_CELLS));
    const count = last + 1;
    for (let j = j0; j < j1; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = data[k - j0 * N];
        if (heights[k] === h) continue;
        heights[k] = h;
        tex[k] = THREE.DataUtils.toHalfFloat(h);
        if (i === 0 || j === 0 || i === N - 1 || j === N - 1) edge = true;
        for (let cj = lo(j); cj <= hi(j); cj++) for (let ci = lo(i); ci <= hi(i); ci++) chunks.add(cj * count + ci);
      }
    }
    // Chunks covering these rows that don't exist yet are due even where the heights didn't change.
    for (let cj = lo(j0); cj <= hi(j1 - 1); cj++)
      for (let ci = 0; ci < count; ci++) if (!this.chunks.has(cj * count + ci)) chunks.add(cj * count + ci);
    this.heightTex.needsUpdate = true;
    return { chunks, edge };
  }

  /** World-space centre of a terrain chunk (job priority, LOD reference). */
  chunkCenter(key: number): THREE.Vector3 {
    return this.grid!.center(key);
  }

  /** Builds chunk `key` from the current heights, or rewrites its existing geometry in place. */
  buildChunk(key: number): void {
    const g = this.ground;
    if (!g) return;
    const N = g.size;
    const count = Math.ceil((N - 1) / CHUNK_CELLS);
    const i0 = (key % count) * CHUNK_CELLS, j0 = Math.floor(key / count) * CHUNK_CELLS;
    const i1 = Math.min(N - 1, i0 + CHUNK_CELLS), j1 = Math.min(N - 1, j0 + CHUNK_CELLS);
    const half = g.worldSize / 2;
    const center = new THREE.Vector3(-half + ((i0 + i1) / 2) * g.cell, 0, -half + ((j0 + j1) / 2) * g.cell);
    const existing = this.chunks.get(key);
    if (existing) {
      for (const lod of existing) {
        lod.fill();
        lod.mesh.userData.boundsDirty = true;
      }
      this.updateWater(key, i0, j0, i1, j1);
      this.updateSuper(key);
      return;
    }
    const lods = TERRAIN_LODS.map(({ step }, level) => {
      const { geo, fill } = terrainChunkGeometry(g, i0, j0, i1, j1, step);
      const mesh = new THREE.Mesh(geo, this.terrainMat);
      mesh.userData.lodCenter = center;
      this.group.add(mesh);
      return { mesh, level, fill };
    });
    this.chunks.set(key, lods);
    this.applyLod(key);
    this.updateWater(key, i0, j0, i1, j1);
    this.updateSuper(key);
  }

  private superKey(chunkKey: number): number {
    const count = Math.ceil((this.ground!.size - 1) / CHUNK_CELLS);
    const per = Math.ceil(count / SUPER_CHUNKS);
    return Math.floor(Math.floor(chunkKey / count) / SUPER_CHUNKS) * per + Math.floor((chunkKey % count) / SUPER_CHUNKS);
  }

  /**
   * Builds the far mesh covering chunk `key` once every chunk it replaces exists (until then those chunks keep their own
   * levels at any distance), or rewrites it in place when one of them changed.
   */
  private updateSuper(key: number): void {
    const g = this.ground;
    if (!g) return;
    const N = g.size;
    const count = Math.ceil((N - 1) / CHUNK_CELLS);
    const per = Math.ceil(count / SUPER_CHUNKS);
    const sKey = this.superKey(key);
    if (this.supers.has(sKey)) {
      this.dirtySupers.add(sKey); // refilled once by `flushSupers`, however many of its chunks changed
      return;
    }
    const sx = sKey % per, sy = Math.floor(sKey / per);
    const keys: number[] = [];
    for (let cj = sy * SUPER_CHUNKS; cj < Math.min(count, (sy + 1) * SUPER_CHUNKS); cj++)
      for (let ci = sx * SUPER_CHUNKS; ci < Math.min(count, (sx + 1) * SUPER_CHUNKS); ci++) keys.push(cj * count + ci);
    if (!keys.every((k) => this.chunks.has(k))) return;
    const span = SUPER_CHUNKS * CHUNK_CELLS;
    const i0 = sx * span, j0 = sy * span;
    const i1 = Math.min(N - 1, i0 + span), j1 = Math.min(N - 1, j0 + span);
    const half = g.worldSize / 2;
    const center = new THREE.Vector3(-half + ((i0 + i1) / 2) * g.cell, 0, -half + ((j0 + j1) / 2) * g.cell);
    const levels = SUPER_LODS.map(({ step }, level) => {
      const { geo, fill } = terrainChunkGeometry(g, i0, j0, i1, j1, step);
      const mesh = new THREE.Mesh(geo, this.terrainMat);
      mesh.userData.lodCenter = center;
      this.group.add(mesh);
      return { mesh, level, fill };
    });
    this.supers.set(sKey, { center, keys, levels });
    this.applyLod(...keys);
  }

  /** Rewrites the far meshes whose chunks changed since the last call (call before the culler picks up `boundsDirty`). */
  flushSupers(): void {
    for (const sKey of this.dirtySupers) {
      const sup = this.supers.get(sKey);
      if (!sup) continue;
      for (const lod of sup.levels) {
        lod.fill();
        lod.mesh.userData.boundsDirty = true;
      }
    }
    this.dirtySupers.clear();
  }

  /** Rebuilds the vertical walls around the map edge from the current heights. */
  buildEdge(): void {
    const g = this.ground;
    if (!g || !this.grid) return;
    for (const m of this.edge) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    // One mesh for the whole perimeter wall (a few thousand triangles; the GPU clips what is off screen), not one per chunk.
    const mesh = new THREE.Mesh(buildSkirtGeometry(g), this.skirtMat);
    mesh.frustumCulled = false;
    mesh.userData.noShadow = true;
    mesh.userData.noCull = true;
    this.edge = [mesh];
    this.group.add(mesh);
  }

  /** Dirt amount (0..1) for rows j0..j1-1 -> cover texture R. */
  applyCover(j0: number, j1: number, dirt: Float32Array): void {
    const tex = this.coverTex;
    if (!tex || !this.ground) return;
    const data = tex.image.data as Uint8Array;
    const base = j0 * this.ground.size;
    for (let k = base; k < j1 * this.ground.size; k++) data[k * 2] = Math.round(dirt[k - base] * 255);
    tex.needsUpdate = true;
  }

  /** Forest canopy under these trees (darkens the ground under woods) -> cover texture G. */
  addCanopy(trees: Tree[]): void {
    const g = this.ground;
    const tex = this.coverTex;
    if (!g || !tex) return;
    const { size: N, cell } = g;
    const half = g.worldSize / 2;
    const data = tex.image.data as Uint8Array;
    for (const tree of trees) {
      const gx = Math.round((tree.x + half) / cell), gy = Math.round((tree.z + half) / cell);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx, y = gy + dy;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const k = y * N + x;
          this.canopy[k] += dx || dy ? 0.12 : 0.3;
          data[k * 2 + 1] = Math.round(Math.min(1, this.canopy[k]) * 255);
        }
    }
    tex.needsUpdate = true;
  }

  /** Scales the terrain detail-level distances (quality setting). */
  setLodScale(scale: number): void {
    this.lodScale = scale;
    this.applyLod(...this.chunks.keys());
    for (const { levels } of this.supers.values()) this.applySuperLod(levels);
  }

  /** Detail-level distances of chunks `keys`; the last level hands over to the super chunk (once it exists) by its centre. */
  private applyLod(...keys: number[]): void {
    const last = TERRAIN_LODS.length - 1;
    for (const key of keys) {
      const lods = this.chunks.get(key);
      if (!lods) continue;
      const sup = this.supers.get(this.superKey(key));
      for (const { mesh, level } of lods) {
        mesh.userData.lodLevel = level; // LOD levels debug view
        mesh.userData.lodMin = level ? TERRAIN_LODS[level - 1].maxDist * this.lodScale : 0;
        if (level === last && !sup) {
          mesh.userData.lodMax = Infinity; // nothing takes over yet
          mesh.userData.lodMaxCenter = undefined;
        } else {
          mesh.userData.lodMax = TERRAIN_LODS[level].maxDist * this.lodScale;
          mesh.userData.lodMaxCenter = level === last ? sup!.center : undefined;
        }
      }
    }
    for (const key of keys) {
      const sup = this.supers.get(this.superKey(key));
      if (sup) this.applySuperLod(sup.levels);
    }
  }

  private applySuperLod(levels: ChunkLod[]): void {
    for (const { mesh, level } of levels) {
      mesh.userData.lodLevel = TERRAIN_LODS.length + level; // LOD levels debug view
      mesh.userData.lodMin = SUPER_LODS[level].minDist * this.lodScale;
      mesh.userData.lodMax = SUPER_LODS[level].maxDist * this.lodScale;
    }
  }

  /**
   * Mountain streams (River.stream): one water ribbon each, a little wider than the channel (the shader drops what lies
   * under the banks), split by chunk and hidden beyond STREAM_DISTANCE. aFlow = downstream direction (xz) and steepness.
   */
  buildStreams(rivers: River[]): void {
    const grid = this.grid;
    if (!grid) return;
    const pos: number[] = [], flow: number[] = [], index: number[] = [];
    for (const { stream } of rivers) {
      const n = stream.length;
      if (n < 2) continue;
      const base = pos.length / 3;
      stream.forEach((p, i) => {
        const a = stream[Math.max(0, i - 1)], b = stream[Math.min(n - 1, i + 1)];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
        const steep = Math.min(1, ((a.y - b.y) / l) * 3);
        const half = p.width / 2 + STREAM_MARGIN;
        for (const s of [-1, 1]) {
          pos.push(p.x - (dz / l) * half * s, p.y, p.z + (dx / l) * half * s);
          flow.push(dx / l, dz / l, steep);
        }
        if (i > 0) {
          const v = base + i * 2;
          index.push(v - 2, v - 1, v, v, v - 1, v + 1);
        }
      });
    }
    if (!index.length) return;
    const whole = new THREE.BufferGeometry();
    whole.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    whole.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 3));
    whole.setIndex(index);
    for (const part of splitByChunk(whole, grid)) {
      const mesh = new THREE.Mesh(part, this.streamMat);
      mesh.renderOrder = 1;
      mesh.userData.noShadow = true;
      mesh.userData.lodMax = STREAM_DISTANCE;
      this.group.add(mesh);
    }
    whole.dispose();
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      this.group.remove(child);
    }
    this.chunks.clear();
    this.supers.clear();
    this.dirtySupers.clear();
    this.waters.clear();
    this.waterMesh = null;
    this.edge = [];
    this.heightTex?.dispose();
    this.heightTex = null;
    this.coverTex?.dispose();
    this.coverTex = null;
    this.ground = null;
  }
}

function dataTexture(data: Uint16Array | Uint8Array, N: number, format: THREE.PixelFormat, type: THREE.TextureDataType): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, N, N, format, type);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * One chunk at grid stride `step`. Neighbouring chunks may use different strides, so their shared
 * edges don't match vertex for vertex; to hide the resulting cracks every border vertex also gets a
 * copy (same position; the `skirt` attribute pushes it to SKIRT_BOTTOM when drawn), forming a vertical wall (both windings) below the edge.
 * Normals come from the full-res heightmap at every level -> seamless lighting.
 * The topology depends only on the chunk bounds; `fill` (re)writes everything that depends on the heights.
 */
function terrainChunkGeometry(
  t: Ground, i0: number, j0: number, i1: number, j1: number, step: number,
): { geo: THREE.BufferGeometry; fill: () => void } {
  const { size: N, cell, heights } = t;
  const half = t.worldSize / 2;
  const h = (i: number, j: number) =>
    heights[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];

  // Sampled grid lines; the chunk's far edge is always included even if the stride doesn't divide it.
  const axis = (a0: number, a1: number) => {
    const out: number[] = [];
    for (let a = a0; a < a1; a += step) out.push(a);
    out.push(a1);
    return out;
  };
  const is = axis(i0, i1), js = axis(j0, j1);
  const w = is.length, d = js.length;

  const border = 2 * (w + d) - 4;
  const count = w * d + border;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const skirt = new Float32Array(count * 3); // zero for surface vertices

  const index: number[] = [];
  for (let j = 0; j < d - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + w, c = a + 1, e = b + 1;
      index.push(a, b, c, c, b, e);
    }
  }

  // Border ring (clockwise from the north-west corner) and its dropped copies.
  const ring: number[] = [];
  for (let i = 0; i < w; i++) ring.push(i);
  for (let j = 1; j < d; j++) ring.push(j * w + w - 1);
  for (let i = w - 2; i >= 0; i--) ring.push((d - 1) * w + i);
  for (let j = d - 2; j >= 1; j--) ring.push(j * w);
  // Chunk sides lying on the map's outer edge get no skirt (the map skirt already closes them).
  const outer = { north: j0 === 0, south: j1 === N - 1, west: i0 === 0, east: i1 === N - 1 };
  const onSide = (v: number) => ({
    north: v < w,
    south: v >= (d - 1) * w,
    west: v % w === 0,
    east: v % w === w - 1,
  });
  const base = w * d;
  for (let n = 0; n < ring.length; n++) {
    const m = (n + 1) % ring.length;
    const sa = onSide(ring[n]), sb = onSide(ring[m]);
    const onOuterSide = (['north', 'south', 'west', 'east'] as const).some((k) => outer[k] && sa[k] && sb[k]);
    if (onOuterSide) continue;
    const a = ring[n], b = ring[m];
    const da = base + n, db = base + m;
    index.push(a, b, da, b, db, da); // front
    index.push(a, da, b, b, da, db); // back
  }

  const fill = () => {
    for (let jj = 0; jj < d; jj++) {
      for (let ii = 0; ii < w; ii++) {
        const i = is[ii], j = js[jj];
        const k = (jj * w + ii) * 3;
        positions[k] = -half + i * cell;
        positions[k + 1] = heights[j * N + i];
        positions[k + 2] = -half + j * cell;
        // Central-difference normal straight from the heightmap.
        const nx = h(i - 1, j) - h(i + 1, j);
        const nz = h(i, j - 1) - h(i, j + 1);
        const ny = 2 * cell;
        const len = Math.hypot(nx, ny, nz);
        normals[k] = nx / len;
        normals[k + 1] = ny / len;
        normals[k + 2] = nz / len;
      }
    }
    ring.forEach((v, n) => {
      const k = base + n;
      positions.set(positions.subarray(v * 3, v * 3 + 3), k * 3);
      normals.set(normals.subarray(v * 3, v * 3 + 3), k * 3);
      // Slightly outward so a wall is never exactly edge-on to the camera (hairline seams).
      const s = onSide(v);
      // No lean across the map's outer edge, or the wall would poke through the map skirt there.
      const lean = (side: 'north' | 'south' | 'west' | 'east') => (s[side] && !outer[side] ? SKIRT_FLARE : 0);
      skirt[k * 3] = lean('east') - lean('west');
      skirt[k * 3 + 1] = SKIRT_BOTTOM - positions[v * 3 + 1];
      skirt[k * 3 + 2] = lean('south') - lean('north');
    });
    for (const name of ['position', 'normal', 'skirt']) geo.attributes[name].needsUpdate = true;
    geo.computeBoundingSphere();
    geo.boundingBox = null;
  };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('skirt', new THREE.BufferAttribute(skirt, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
  fill();
  return { geo, fill };
}

/** Vertical walls around the map edge: earth below terrain, water above it where submerged. */
function buildSkirtGeometry(t: Ground): THREE.BufferGeometry {
  const { size: N, cell, heights, waterLevel } = t;
  const half = t.worldSize / 2;
  const earth = new THREE.Color(0x4a3a2a);
  const water = new THREE.Color(0x1f3238);
  const pos: number[] = [];
  const col: number[] = [];

  const quad = (ax: number, az: number, bx: number, bz: number, a0: number, a1: number, b0: number, b1: number, c: THREE.Color) => {
    pos.push(ax, a0, az, bx, b0, bz, bx, b1, bz, ax, a0, az, bx, b1, bz, ax, a1, az);
    for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
  };

  // Each edge as a list of grid indices (i, j).
  const edges: [number, number][][] = [
    Array.from({ length: N }, (_, i) => [i, 0]),
    Array.from({ length: N }, (_, i) => [i, N - 1]),
    Array.from({ length: N }, (_, j) => [0, j]),
    Array.from({ length: N }, (_, j) => [N - 1, j]),
  ];

  for (const edge of edges) {
    for (let s = 0; s < edge.length - 1; s++) {
      const [ia, ja] = edge[s];
      const [ib, jb] = edge[s + 1];
      const ax = -half + ia * cell, az = -half + ja * cell;
      const bx = -half + ib * cell, bz = -half + jb * cell;
      const ha = heights[ja * N + ia];
      const hb = heights[jb * N + ib];
      quad(ax, az, bx, bz, SKIRT_BOTTOM, ha, SKIRT_BOTTOM, hb, earth);
      if (ha < waterLevel || hb < waterLevel) {
        quad(ax, az, bx, bz, ha, Math.max(ha, waterLevel), hb, Math.max(hb, waterLevel), water);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}
