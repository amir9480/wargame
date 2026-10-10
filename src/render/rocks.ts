import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, hash32, type Rng } from '../core/rng.ts';
import { ROCK_VARIANTS, SNOW_LINE, sampleGrid, type Rock, type Terrain } from '../terrain/generate.ts';
import type { Environment, TerrainTextures } from './world.ts';
import { groupByChunk, type ChunkGrid } from './culling.ts';
import rockVertex from './shaders/rock.vert.glsl';
import rockFragment from './shaders/rock.frag.glsl';
import { SHADOW_ONLY_MATERIAL, SPRITE_LOD_BLEND, SPRITE_PITCH_COUNT, applySpriteAtlas, bakeAtlas, bakeMaterial, createSpriteLod, createSpriteMaterial, shadowProxy, spriteAttribute, spriteQuadAll, type SpriteAtlas, type SpriteLod } from './billboard.ts';

/** Fixed seed for the rock meshes: shapes are shared by every map. */
const SHAPE_SEED = 7919;
/** Local y of the flat underside of every rock shape (radius 1). */
const ROCK_BASE = -0.45;
/** Rocks sink this fraction of their size into the ground so they look embedded. */
const SINK = 0.15;

const BILLBOARD_RES = 128;
/** World height rocks are baked at: above the moss fade, below the snow line, so the sprite is plain stone. */
const BAKE_Y = 18;

/** Linear multipliers on the rock texture: grey, warm, cool, sandy. */
const ROCK_TINTS = [
  [1.0, 1.0, 1.0],
  [1.08, 0.98, 0.86],
  [0.9, 0.93, 0.98],
  [1.12, 1.04, 0.88],
].map(([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace));

/** Heightmap the rocks stand on. */
type GroundSampler = Pick<Terrain, 'heights' | 'size' | 'cell' | 'worldSize'>;

/** One rock's instance transform and tint. */
interface Placed {
  x: number;
  z: number;
  variant: number;
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

/** Instanced rock meshes, one InstancedMesh per shape variant. */
export class RockLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  /** The sprite material: all shapes share it (atlas row, quad size and height come per instance, `aSprite`), so a chunk's far rocks are one draw. */
  readonly billboardMaterials: THREE.ShaderMaterial[];
  private shapes: THREE.BufferGeometry[];
  /** Low-poly shadow casters of the far (sprite) level, per shape. */
  private proxies: THREE.BufferGeometry[];
  /** Baked sprites of every shape (one row each) at all camera pitches, see `bakeAtlas`. */
  private atlas: SpriteAtlas | null = null;
  /** Near mesh / sprite switch distance + bias, shared by all materials. */
  private lod: SpriteLod;
  private renderer: THREE.WebGLRenderer;
  private hasRocks = false;
  /** Sprite quad covering every shape's sprite; each far mesh clones it to carry its own `aSprite` attribute. */
  private quad: THREE.PlaneGeometry | null = null;
  /** Per map chunk: its rocks so far (generation order) and their meshes. */
  private chunks = new Map<number, { placed: Placed[]; meshes: THREE.InstancedMesh[] }>();
  private rng: Rng | null = null;
  /** Chunks whose centre is farther than this from the camera draw billboards instead of meshes (quality setting). */
  private lodDistance = 200;
  /** Sprites beyond this camera distance are not drawn (quality `propDistance`). */
  private farDistance = Infinity;
  constructor(textures: TerrainTextures, env: Environment, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.lod = createSpriteLod(this.lodDistance, textures.shadowNoise);
    const rng = mulberry32(SHAPE_SEED);
    this.shapes = Array.from({ length: ROCK_VARIANTS }, () => createRockGeometry(rng));
    this.proxies = this.shapes.map((shape) => shadowProxy(shape, 'blob'));
    this.material = new THREE.ShaderMaterial({
      vertexShader: rockVertex,
      fragmentShader: rockFragment,
      uniforms: {
        tRock: { value: textures.rock },
        tGrass: { value: textures.grass },
        tSnow: { value: textures.snow },
        sunDir: { value: env.sunDir },
        sunColor: { value: env.sunColor },
        skyAmbient: { value: env.skyAmbient },
        groundAmbient: { value: env.groundAmbient },
        ...env.fog,
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
        snowLine: { value: SNOW_LINE },
        ...this.lod,
      },
    });
    this.billboardMaterials = [createSpriteMaterial(env, this.lod, true)];
  }

  /** Renders every shape at every sprite pitch into the atlas (reusing its texture when there is one). */
  private bake(colFrom = 0, colTo = SPRITE_PITCH_COUNT): SpriteAtlas {
    const material = bakeMaterial(this.material);
    const entries = this.shapes.map((geometry) => ({ geometry, material, originY: BAKE_Y }));
    const atlas = bakeAtlas(this.renderer, entries, BILLBOARD_RES, this.atlas ?? undefined, colFrom, colTo);
    material.dispose();
    return (this.atlas = atlas);
  }

  /** Re-bakes the sprites with the current lighting (time of day). */
  rebake(): void {
    if (!this.hasRocks) return; // `add` bakes fresh for the next map
    applySpriteAtlas(this.billboardMaterials[0], this.bake());
  }

  /** Re-bakes one pitch column of the atlas (the same texture); a full re-bake spread over frames. */
  rebakeColumn(col: number): void {
    if (this.hasRocks && this.atlas) this.bake(col, col + 1);
  }

  /** Starts a new map: removes the old rocks; `add` then brings in the new ones band by band. */
  begin(seed: number): void {
    this.clear();
    // Tints are cosmetic, but still seeded so a map always looks the same.
    this.rng = mulberry32(hash32(seed, 0x70c5));
  }

  /** Whole map at once. */
  build(terrain: Terrain, grid: ChunkGrid): void {
    this.begin(terrain.seed);
    this.add(terrain, terrain.rocks, grid);
  }

  /**
   * Adds rocks (in generation order) standing on `ground`. One InstancedMesh per (map chunk, rock shape), so the
   * culler can skip off-screen chunks; a chunk that already has rocks is rebuilt with the new ones appended.
   */
  add(ground: GroundSampler, rocks: Rock[], grid: ChunkGrid): void {
    const rng = this.rng;
    if (!rocks.length || !rng) return;
    const q = new THREE.Quaternion();
    const yawQ = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3();

    // Transform + tint per rock, in generation order (independent of chunking).
    const placed = rocks.map((r) => {
      groundNormal(ground, r.x, r.z, normal);
      // Lean with the slope, but not fully: boulders rest, they don't glue on.
      normal.lerp(up, 0.35).normalize();
      q.setFromUnitVectors(up, normal).multiply(yawQ.setFromAxisAngle(up, r.yaw));
      pos.set(r.x, r.y - (ROCK_BASE + SINK) * r.size, r.z);
      scale.setScalar(r.size);
      const matrix = new THREE.Matrix4().compose(pos, q, scale);
      const color = ROCK_TINTS[Math.floor(rng() * ROCK_TINTS.length)].clone().multiplyScalar(0.85 + rng() * 0.3);
      return { x: r.x, z: r.z, variant: r.variant, matrix, color };
    });

    if (!this.hasRocks) {
      this.hasRocks = true;
      const atlas = this.bake();
      applySpriteAtlas(this.billboardMaterials[0], atlas);
      this.quad = spriteQuadAll(atlas);
    }
    const atlas = this.atlas!;

    for (const [key, more] of groupByChunk(placed, grid)) {
      let entry = this.chunks.get(key);
      if (!entry) this.chunks.set(key, (entry = { placed: [], meshes: [] }));
      for (const m of entry.meshes) {
        m.dispose();
        if (m.userData.ownGeometry) m.geometry.dispose();
        this.group.remove(m);
      }
      entry.meshes = [];
      entry.placed.push(...more);
      const chunk = entry.placed;
      const lodCenter = grid.center(key);
      for (let v = 0; v < ROCK_VARIANTS; v++) {
        const rocks = chunk.filter((r) => r.variant === v);
        if (!rocks.length) continue;
        const mesh = new THREE.InstancedMesh(this.shapes[v], this.material, rocks.length);
        rocks.forEach((r, n) => {
          mesh.setMatrixAt(n, r.matrix);
          mesh.setColorAt(n, r.color);
        });
        mesh.userData.lodMax = this.lodDistance;
        mesh.userData.lodNear = true;
        mesh.userData.lodBlend = SPRITE_LOD_BLEND;
        mesh.userData.lodCenter = lodCenter;

        // The far level's shadows come from low-poly stand-ins (sprites can't cast shadow-map shadows).
        const caster = new THREE.InstancedMesh(this.proxies[v], SHADOW_ONLY_MATERIAL, rocks.length);
        rocks.forEach((r, n) => caster.setMatrixAt(n, r.matrix));
        caster.userData.lodMin = this.lodDistance;
        caster.userData.shadowOnly = true;
        caster.userData.lodCenter = lodCenter;
        this.limitFar(caster);
        entry.meshes.push(mesh, caster);
        this.group.add(mesh, caster);
      }

      // Same rocks as flat sprites for when the chunk is far from the camera: every shape in ONE mesh (the sprite's atlas
      // row / size come per instance), so a chunk's far rocks are a single draw call instead of one per shape.
      const geo = this.quad!.clone();
      geo.setAttribute('aSprite', spriteAttribute(atlas, chunk.map((r) => r.variant)));
      const far = new THREE.InstancedMesh(geo, this.billboardMaterials[0], chunk.length);
      chunk.forEach((r, n) => {
        far.setMatrixAt(n, r.matrix);
        far.setColorAt(n, r.color);
      });
      far.userData.lodMin = this.lodDistance;
      far.userData.lodBlend = SPRITE_LOD_BLEND;
      far.userData.noShadow = true;
      far.userData.lodCenter = lodCenter;
      far.userData.ownGeometry = true; // the clone is freed with the mesh
      this.limitFar(far);
      entry.meshes.push(far);
      this.group.add(far);
    }
  }

  /** Moves the mesh / billboard switch distance of every chunk, built or future. */
  setLodDistance(distance: number, farDistance = Infinity): void {
    this.lodDistance = distance;
    this.farDistance = farDistance;
    this.lod.lodSwitch.value = distance;
    for (const child of this.group.children) {
      if (child.userData.lodNear) child.userData.lodMax = distance; // full mesh
      else {
        child.userData.lodMin = distance; // sprite / shadow stand-in
        this.limitFar(child);
      }
    }
  }

  /** Sprites / stand-ins beyond `farDistance` are not drawn at all (quality: propDistance). */
  private limitFar(mesh: THREE.Object3D): void {
    if (Number.isFinite(this.farDistance)) mesh.userData.lodMax = this.farDistance;
    else delete mesh.userData.lodMax;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      // Shape geometries are shared across builds; only free per-build instance buffers.
      if (child instanceof THREE.InstancedMesh) {
        child.dispose();
        if (child.userData.ownGeometry) child.geometry.dispose();
      }
      this.group.remove(child);
    }
    this.quad?.dispose();
    this.quad = null;
    this.chunks.clear();
    this.hasRocks = false;
    this.rng = null;
  }
}

function groundNormal(t: GroundSampler, x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const half = t.worldSize / 2;
  const gx = (x + half) / t.cell;
  const gy = (z + half) / t.cell;
  const h = (dx: number, dy: number) => sampleGrid(t.heights, t.size, gx + dx, gy + dy);
  return out.set(h(-1, 0) - h(1, 0), 2 * t.cell, h(0, -1) - h(0, 1)).normalize();
}

/** Low-poly boulder: a jittered, squashed icosphere with flat-shaded facets. Radius ~1, base at ROCK_BASE. */
function createRockGeometry(rng: Rng): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico); // shared vertices -> jitter keeps the surface closed
  ico.dispose();

  const sx = 0.85 + rng() * 0.3;
  const sy = 0.5 + rng() * 0.3;
  const sz = 0.65 + rng() * 0.3;
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let k = 0; k < p.count; k++) {
    v.fromBufferAttribute(p, k).multiplyScalar(0.8 + rng() * 0.32);
    p.setXYZ(k, v.x * sx, Math.max(v.y * sy, ROCK_BASE), v.z * sz); // flat underside
  }

  const flat = geo.toNonIndexed();
  geo.dispose();
  flat.computeVertexNormals();
  return flat;
}
