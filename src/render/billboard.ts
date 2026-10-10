// Far-LOD sprites: an object is rendered once offscreen, then every distant instance
// draws that texture on a camera-facing quad.

import * as THREE from 'three';
import type { Environment } from './world.ts';
import billboardVertex from './shaders/billboard.vert.glsl';
import billboardFragment from './shaders/billboard.frag.glsl';

/** Camera elevations (radians above the horizon) the sprites are baked at: the atlas has one column per pitch. */
export const SPRITE_PITCH_MIN = 0.3;
export const SPRITE_PITCH_STEP = 0.2;
export const SPRITE_PITCH_COUNT = 7; // 0.3 .. 1.5, the camera's pitch range

/**
 * Detail / sprite overlap in metres: a near mesh is drawn up to `lodSwitch + bias`, its sprite from `lodSwitch - bias`
 * (decided per instance in the vertex shaders), so at the switch both show and nothing ever drops out.
 */
export const SPRITE_LOD_BIAS = 10;
/**
 * Extra range of the chunk-level cull around the switch distance (`userData.lodBlend`): the bias plus half a chunk
 * diagonal, so the culler never hides a chunk holding an instance the shader still draws.
 */
export const SPRITE_LOD_BLEND = SPRITE_LOD_BIAS + 48;

/** Switch distance, bias and the blue noise of the dithered cross-fade, shared by a layer's near mesh and sprite materials (shader uniform objects). */
export function createSpriteLod(distance: number, noise: THREE.Texture) {
  return { lodSwitch: { value: distance }, lodBias: { value: SPRITE_LOD_BIAS }, tNoise: { value: noise } };
}
export type SpriteLod = ReturnType<typeof createSpriteLod>;

/** All sprites of a layer baked once: one row per model, one column per camera pitch, in a single texture. */
export interface SpriteAtlas {
  target: THREE.WebGLRenderTarget;
  /** Per row (model): world size of the square quad at instance scale 1, and its centre height above the root. */
  rows: { size: number; centerY: number }[];
}

/**
 * Low-poly stand-in that casts the shadow of a shape drawn as a sprite (sprites can't cast shadow-map shadows): a
 * 6-sided cone (pines) or a 20-triangle blob (crowns, rocks) over the shape's bounding box. Drawn in shadow passes only
 * (`userData.shadowOnly`), with the same instance matrices as the sprites.
 */
export function shadowProxy(shape: THREE.BufferGeometry, kind: 'cone' | 'blob'): THREE.BufferGeometry {
  shape.computeBoundingBox();
  const box = shape.boundingBox!;
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const geo = kind === 'cone' ? new THREE.ConeGeometry(Math.max(size.x, size.z) / 2, size.y, 6) : new THREE.IcosahedronGeometry(1, 0);
  if (kind === 'blob') geo.scale(size.x / 2, size.y / 2, size.z / 2);
  geo.translate(center.x, center.y, center.z);
  return geo;
}

/** Placeholder material of shadow-only meshes (the shadow pass draws them with its own depth material). */
export const SHADOW_ONLY_MATERIAL = new THREE.MeshBasicMaterial({ colorWrite: false });

/**
 * Material drawing one row of a sprite atlas on instanced camera-facing quads; atlas via `applySprite`.
 * `perInstance`: the row, quad size and centre height come from the instanced attribute `aSprite` (vec3), so one mesh can
 * hold several models (fewer draw calls); the atlas is then set with `applySpriteAtlas`.
 */
export function createSpriteMaterial(env: Environment, lod: SpriteLod, perInstance = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: perInstance ? { SPRITE_ATTR: '' } : {},
    vertexShader: billboardVertex,
    fragmentShader: billboardFragment,
    uniforms: {
      tBillboard: { value: null },
      markSprite: { value: 1 },
      quadSize: { value: 10 },
      centerY: { value: 4 },
      atlasRow: { value: 0 },
      atlasRows: { value: 1 },
      pitchCols: { value: SPRITE_PITCH_COUNT },
      pitchMin: { value: SPRITE_PITCH_MIN },
      pitchStep: { value: SPRITE_PITCH_STEP },
      ...env.fog,
      fogNear: { value: 400 },
      fogFar: { value: 1200 },
      ...lod,
    },
  });
}

export function applySprite(material: THREE.ShaderMaterial, atlas: SpriteAtlas, row: number): void {
  const u = material.uniforms;
  u.tBillboard.value = atlas.target.texture;
  u.quadSize.value = atlas.rows[row].size;
  u.centerY.value = atlas.rows[row].centerY;
  u.atlasRow.value = row;
  u.atlasRows.value = atlas.rows.length;
}

/** Atlas of a `perInstance` sprite material (the rows are picked per instance, see `spriteQuadAll` / `spriteAttribute`). */
export function applySpriteAtlas(material: THREE.ShaderMaterial, atlas: SpriteAtlas): void {
  material.uniforms.tBillboard.value = atlas.target.texture;
  material.uniforms.atlasRows.value = atlas.rows.length;
}

/** Quad covering every row's sprite (largest size, tallest centre), so one culling box fits the instances of any model. */
export function spriteQuadAll(atlas: SpriteAtlas): THREE.PlaneGeometry {
  const size = Math.max(...atlas.rows.map((r) => r.size));
  const top = Math.max(...atlas.rows.map((r) => r.centerY));
  return new THREE.PlaneGeometry(size, size).translate(0, top, 0);
}

/** Instanced `aSprite` attribute (row, quad size, centre height) for instances whose model rows are `rows`. */
export function spriteAttribute(atlas: SpriteAtlas, rows: number[]): THREE.InstancedBufferAttribute {
  const data = new Float32Array(rows.length * 3);
  rows.forEach((row, i) => data.set([row, atlas.rows[row].size, atlas.rows[row].centerY], i * 3));
  return new THREE.InstancedBufferAttribute(data, 3);
}

/** Real-sized quad around the sprite's centre, so the culler's boxes cover the drawn sprites. */
export function spriteQuad(atlas: SpriteAtlas, row: number): THREE.PlaneGeometry {
  const { size, centerY } = atlas.rows[row];
  return new THREE.PlaneGeometry(size, size).translate(0, centerY, 0);
}

/** Copy of a near-mesh material for baking: fog off, near / sprite switch pushed out of reach (the model is always drawn whole). */
export function bakeMaterial(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const mat = material.clone();
  mat.uniforms.fogNear.value = 1e9; // no fog in the sprite; applied when drawn
  mat.uniforms.fogFar.value = 2e9;
  mat.uniforms.aerialScale = { value: 0 };
  // clone() copies textures; render-target textures must stay the originals.
  mat.uniforms.tAerial = material.uniforms.tAerial;
  mat.uniforms.tSkyView = material.uniforms.tSkyView;
  mat.uniforms.fogOrigin = { value: new THREE.Vector3() };
  mat.uniforms.lodSwitch = { value: 1e9 };
  mat.uniforms.lodBias = { value: 1 };
  return mat;
}

export interface BakeEntry {
  geometry: THREE.BufferGeometry;
  /** Instancing-capable material from `bakeMaterial` (caller configures it). */
  material: THREE.Material;
  /** Height the model is placed at (world-position shading, e.g. rock moss / snow). */
  originY: number;
}

/**
 * Renders every entry once (orthographic, transparent background) at every sprite pitch into one atlas texture:
 * row = entry, column = pitch. Drawing from the live camera needs no re-bake, only a lighting change does; pass the
 * previous atlas to draw into its texture again.
 */
export function bakeAtlas(renderer: THREE.WebGLRenderer, entries: BakeEntry[], resolution: number, previous?: SpriteAtlas): SpriteAtlas {
  const cols = SPRITE_PITCH_COUNT;
  const width = cols * resolution, height = entries.length * resolution;
  let target = previous?.target;
  if (!target || target.width !== width || target.height !== height) {
    target?.dispose();
    target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      anisotropy: 4,
    });
  }

  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x59603f, 0); // transparent but object-ish coloured: mip filtering leaves no dark fringes
  target.scissorTest = true; // one cell at a time

  const rows = entries.map((entry, row) => {
    const { geometry, material, originY } = entry;
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    const centerY = (bb.min.y + bb.max.y) / 2;
    // Square view covering the object from any angle: bounding-sphere diameter around its centre.
    let radius = 0;
    for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
      radius = Math.max(radius, Math.hypot(x, y - centerY, z));
    }
    const size = radius * 2 * 1.04;

    const mesh = new THREE.InstancedMesh(geometry, material, 1);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, originY, 0));
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);

    const center = new THREE.Vector3(0, originY + centerY, 0);
    const camera = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0.1, 400);
    for (let col = 0; col < cols; col++) {
      const pitch = SPRITE_PITCH_MIN + col * SPRITE_PITCH_STEP;
      camera.position.set(0, center.y + Math.sin(pitch) * 200, Math.cos(pitch) * 200);
      camera.lookAt(center);
      target.viewport.set(col * resolution, row * resolution, resolution, resolution);
      target.scissor.copy(target.viewport);
      renderer.setRenderTarget(target); // applies the cell's viewport / scissor
      renderer.render(scene, camera);
    }
    mesh.dispose();
    return { size, centerY };
  });

  target.scissorTest = false;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  return { target, rows };
}
