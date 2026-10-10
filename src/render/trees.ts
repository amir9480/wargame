import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, hash32, type Rng } from '../core/rng.ts';
import type { Terrain, Tree, TreeType } from '../terrain/generate.ts';
import type { Environment } from './world.ts';
import { groupByChunk, type ChunkGrid } from './culling.ts';
import treeVertex from './shaders/tree.vert.glsl';
import treeFragment from './shaders/tree.frag.glsl';
import { SHADOW_ONLY_MATERIAL, SPRITE_LOD_BLEND, SPRITE_PITCH_COUNT, applySprite, bakeAtlas, bakeMaterial, createSpriteLod, createSpriteMaterial, shadowProxy, spriteQuad, type SpriteAtlas, type SpriteLod } from './billboard.ts';

/** Fixed seed for the tree meshes: shapes are shared by every map. */
const SHAPE_SEED = 4241;
/** Height of each species' mesh at scale 1, in world units. */
const TREE_HEIGHT: Record<TreeType, number> = { pine: 8.6, broadleaf: 7.2 };

/** One tree's instance transform and tint. */
interface Placed {
  x: number;
  z: number;
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

/** Resolution of the baked billboard texture. */
const BILLBOARD_RES = 256;
/** Beyond this camera distance (m) trees cast shadows through their low-poly stand-in instead of the full mesh (a shadow pass drew 500k tree triangles). */
const SHADOW_MESH_DISTANCE = 90;

/**
 * All trees of a map as one InstancedMesh: a single merged mesh (trunk + foliage,
 * vertex coloured) per species -> one draw call for the whole forest.
 */
export class TreeLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly billboardMaterial: THREE.ShaderMaterial;
  private shapes: Record<TreeType, THREE.BufferGeometry>;
  /** Low-poly shadow casters of the far (sprite) level, per species. */
  private proxies: Record<TreeType, THREE.BufferGeometry>;
  /** Baked sprites of the map's species (all camera pitches), see `bakeAtlas`. */
  private atlas: SpriteAtlas | null = null;
  /** Near mesh / sprite switch distance + bias, shared by both materials. */
  private lod: SpriteLod;
  private type: TreeType | null = null;
  /** Sprite quad shared by the far meshes of the current map. */
  private quad: THREE.PlaneGeometry | null = null;
  /** Per map chunk: its trees so far (generation order) and their meshes. */
  private chunks = new Map<number, { placed: Placed[]; meshes: THREE.InstancedMesh[] }>();
  private rng: Rng | null = null;
  /** Chunks whose centre is farther than this from the camera draw billboards instead of meshes (quality setting). */
  private lodDistance = 230;
  /** Sprites beyond this camera distance are not drawn (quality `propDistance`). */
  private farDistance = Infinity;
  private renderer: THREE.WebGLRenderer;

  constructor(env: Environment, renderer: THREE.WebGLRenderer, noise: THREE.Texture) {
    this.renderer = renderer;
    this.lod = createSpriteLod(this.lodDistance, noise);
    const rng = mulberry32(SHAPE_SEED);
    this.shapes = { pine: createPine(rng), broadleaf: createBroadleaf(rng) };
    this.proxies = { pine: shadowProxy(this.shapes.pine, 'cone'), broadleaf: shadowProxy(this.shapes.broadleaf, 'blob') };
    this.material = new THREE.ShaderMaterial({
      vertexShader: treeVertex,
      fragmentShader: treeFragment,
      vertexColors: true,
      uniforms: {
        time: { value: 0 },
        treeHeight: { value: 8 },
        sunDir: { value: env.sunDir },
        sunColor: { value: env.sunColor },
        skyAmbient: { value: env.skyAmbient },
        groundAmbient: { value: env.groundAmbient },
        ...env.fog,
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
        ...this.lod,
      },
    });
    this.billboardMaterial = createSpriteMaterial(env, this.lod);
  }

  /** Renders the species at every sprite pitch into the atlas (reusing its texture when there is one). */
  private bake(type: TreeType, colFrom = 0, colTo = SPRITE_PITCH_COUNT): SpriteAtlas {
    const material = bakeMaterial(this.material);
    material.uniforms.time.value = 0;
    material.uniforms.treeHeight.value = TREE_HEIGHT[type];
    const atlas = bakeAtlas(this.renderer, [{ geometry: this.shapes[type], material, originY: 0 }], BILLBOARD_RES, this.atlas ?? undefined, colFrom, colTo);
    material.dispose();
    return (this.atlas = atlas);
  }

  /** Re-bakes the sprites with the current lighting (time of day). */
  rebake(): void {
    if (!this.type || !this.atlas) return;
    applySprite(this.billboardMaterial, this.bake(this.type), 0);
  }

  /** Re-bakes one pitch column of the atlas (the same texture, so nothing else to update); a full re-bake spread over frames. */
  rebakeColumn(col: number): void {
    if (this.type && this.atlas) this.bake(this.type, col, col + 1);
  }

  /** Starts a new map: removes the old trees; `add` then brings in the new ones band by band. */
  begin(seed: number): void {
    this.clear();
    // Cosmetic variation, seeded so a map always looks the same (generation order, not chunk order).
    this.rng = mulberry32(hash32(seed, 0x7ee));
  }

  /** Whole map at once. */
  build(terrain: Terrain, grid: ChunkGrid): void {
    this.begin(terrain.seed);
    this.add(terrain.trees.type, terrain.trees.trees, grid);
  }

  /**
   * Adds trees (in generation order). One InstancedMesh per map chunk (a single draw call each), so the culler can
   * skip off-screen chunks; a chunk that already has trees is rebuilt with the new ones appended.
   */
  add(type: TreeType, trees: Tree[], grid: ChunkGrid): void {
    if (!trees.length || !this.rng) return;
    if (!this.quad) {
      this.material.uniforms.treeHeight.value = TREE_HEIGHT[type];
      this.type = type;
      const atlas = this.bake(type);
      applySprite(this.billboardMaterial, atlas, 0);
      // Real-sized quad so the culler's per-chunk box covers the sprites.
      this.quad = spriteQuad(atlas, 0);
    }

    const rng = this.rng;
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const placed = trees.map((t) => {
      pos.set(t.x, t.y - 0.15, t.z);
      q.setFromAxisAngle(up, t.yaw);
      scale.set(t.scale, t.scale * (0.9 + rng() * 0.25), t.scale);
      const matrix = new THREE.Matrix4().compose(pos, q, scale);
      // Slight brightness / hue shifts so forests don't look cloned.
      const color = new THREE.Color().setRGB(0.85 + rng() * 0.25, 0.88 + rng() * 0.2, 0.8 + rng() * 0.2, THREE.LinearSRGBColorSpace);
      return { x: t.x, z: t.z, matrix, color };
    });

    for (const [key, more] of groupByChunk(placed, grid)) {
      let entry = this.chunks.get(key);
      if (!entry) this.chunks.set(key, (entry = { placed: [], meshes: [] }));
      for (const m of entry.meshes) {
        m.dispose();
        this.group.remove(m);
      }
      entry.placed.push(...more);
      const chunk = entry.placed;
      const lodCenter = grid.center(key);
      const mesh = new THREE.InstancedMesh(this.shapes[this.type!], this.material, chunk.length);
      chunk.forEach((t, i) => {
        mesh.setMatrixAt(i, t.matrix);
        mesh.setColorAt(i, t.color);
      });
      mesh.userData.lodMax = this.lodDistance;
      mesh.userData.lodNear = true;
      mesh.userData.shadowLodMax = Math.min(SHADOW_MESH_DISTANCE, this.lodDistance);
      mesh.userData.lodBlend = SPRITE_LOD_BLEND;
      mesh.userData.lodCenter = lodCenter;

      // Same instances as flat sprites for when the chunk is far from the camera.
      const far = new THREE.InstancedMesh(this.quad, this.billboardMaterial, chunk.length);
      chunk.forEach((t, i) => {
        far.setMatrixAt(i, t.matrix);
        far.setColorAt(i, t.color);
      });
      far.userData.lodMin = this.lodDistance;
      far.userData.lodBlend = SPRITE_LOD_BLEND;
      far.userData.noShadow = true; // sprites don't cast shadow-map shadows
      far.userData.lodCenter = lodCenter;
      this.limitFar(far);
      // ... the far level's shadows come from low-poly stand-ins instead.
      const caster = new THREE.InstancedMesh(this.proxies[this.type!], SHADOW_ONLY_MATERIAL, chunk.length);
      chunk.forEach((t, i) => caster.setMatrixAt(i, t.matrix));
      caster.userData.lodMin = this.lodDistance;
      caster.userData.shadowLodMin = Math.min(SHADOW_MESH_DISTANCE, this.lodDistance);
      caster.userData.shadowOnly = true;
      caster.userData.lodCenter = lodCenter;
      this.limitFar(caster);
      entry.meshes = [mesh, far, caster];
      this.group.add(mesh, far, caster);
    }
  }

  update(time: number): void {
    this.material.uniforms.time.value = time;
  }

  /** Moves the mesh / billboard switch distance of every chunk, built or future. */
  setLodDistance(distance: number, farDistance = Infinity): void {
    this.lodDistance = distance;
    this.farDistance = farDistance;
    this.lod.lodSwitch.value = distance;
    for (const child of this.group.children) {
      if (child.userData.lodNear) {
        child.userData.lodMax = distance; // full mesh
        child.userData.shadowLodMax = Math.min(SHADOW_MESH_DISTANCE, distance);
      } else {
        child.userData.lodMin = distance; // sprite / shadow stand-in
        if (child.userData.shadowOnly) child.userData.shadowLodMin = Math.min(SHADOW_MESH_DISTANCE, distance);
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
      // Species geometries are shared across builds; only free per-build instance buffers.
      if (child instanceof THREE.InstancedMesh) child.dispose();
      this.group.remove(child);
    }
    this.quad?.dispose();
    this.quad = null;
    this.chunks.clear();
    this.rng = null;
  }
}

// ---------- Procedural low-poly tree meshes ----------

/** Geometry with a solid vertex colour, darkened towards the bottom (cheap ambient occlusion). */
function painted(geo: THREE.BufferGeometry, hex: number, rng: Rng, jitter = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  const base = new THREE.Color(hex);
  const p = g.attributes.position;
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 3) {
    // Per-face shade variation for a faceted, hand-made look.
    const shade = 1 + (rng() - 0.5) * jitter;
    for (let v = i; v < i + 3; v++) {
      const ao = 0.75 + 0.25 * Math.min(1, Math.max(0, p.getY(v) / 4));
      colors.set([base.r * shade * ao, base.g * shade * ao, base.b * shade * ao], v * 3);
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals(); // non-indexed -> flat shaded facets
  return g;
}

/** Randomly pushes vertices in/out (shared vertices stay shared, so the surface stays closed). */
function lumpy(geo: THREE.BufferGeometry, rng: Rng, amount: number): THREE.BufferGeometry {
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  const g = mergeVertices(geo);
  geo.dispose();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 1 + (rng() - 0.5) * amount;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * (1 + (rng() - 0.5) * amount * 0.5), p.getZ(i) * s);
  }
  return g;
}

function createPine(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(painted(new THREE.CylinderGeometry(0.16, 0.26, 2.4, 6).translate(0, 1.2, 0), 0x5a3f2c, rng, 0.1));
  // Three stacked, slightly lumpy cones, darker at the bottom.
  const tiers: [radius: number, height: number, base: number, hex: number][] = [
    [2.4, 3.6, 1.5, 0x233a2a],
    [1.9, 3.2, 3.4, 0x28402e],
    [1.25, 2.9, 5.7, 0x2d4733],
  ];
  for (const [r, h, y, hex] of tiers) {
    const cone = lumpy(new THREE.ConeGeometry(r, h, 8, 1).translate(0, y + h / 2, 0), rng, 0.18);
    parts.push(painted(cone, hex, rng, 0.18));
  }
  return merge(parts);
}

function createBroadleaf(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(painted(new THREE.CylinderGeometry(0.2, 0.32, 3.4, 6).translate(0, 1.7, 0), 0x604431, rng, 0.1));
  // A crown of a few overlapping, lumpy blobs.
  const blobs: [x: number, y: number, z: number, r: number, hex: number][] = [
    [0, 4.9, 0, 2.2, 0x7a4a22],
    [1.1, 4.2, 0.5, 1.6, 0x8c5c28],
    [-0.9, 4.4, -0.6, 1.7, 0x6b4020],
    [0.2, 5.9, -0.3, 1.3, 0x9a7034],
  ];
  for (const [x, y, z, r, hex] of blobs) {
    const blob = lumpy(new THREE.IcosahedronGeometry(r, 1).scale(1, 0.85, 1).translate(x, y, z), rng, 0.25);
    parts.push(painted(blob, hex, rng, 0.2));
  }
  return merge(parts);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geo = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  return geo;
}
