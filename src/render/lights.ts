// Deferred local lights (point and spot).
//
// Every light is an instanced sphere ("light volume") in a scene of its own. Per frame the volumes that
// pass chunk culling are drawn additively with the main camera into a light buffer; each pixel
// rebuilds its surface point / normal from the scene depth and writes the irradiance it receives
// (light.frag.glsl). The post pass then multiplies the buffer with the surface colour (post.frag.glsl),
// so no material shader needs to know about lights.
//
// Lights are never distance-culled. Far away a light is also drawn as a bright disc (lighthalo.*), which fades in with
// camera distance while the lamp model is still visible (see setHaloRange).
//
// Low quality skips all of that: each light then becomes two cheap additive quads in the main scene (a glow
// facing the camera and a pool of light draped over the ground), see the `fake` meshes below.
//
// High quality adds light rays: an animated, streaky additive beam from every spot light down to the ground (ray.frag.glsl, a screen-space march added in the post pass).
//
// With the post pass every light also gets a wet-street reflection: a vertical streak on asphalt / sidewalks / car parks
// (reflect.*.glsl, masked by wetmask.ts), drawn into the same half-resolution target as the rays. Lit things that are not
// LightDefs (windows, signs) get streaks too, through their own ReflectionGroup (`field.createReflections`).
//
// Lights are registered in groups (street lights, later unit lamps, muzzle flashes, ...). A group is
// split into one InstancedMesh per map chunk, so the Culler skips off-screen / distant chunks, and has
// a dimmer (`level`) to switch it on and off without rebuilding.

import * as THREE from 'three';
import type { TownLod } from './townLod.ts';
import { Culler, groupByChunk, type ChunkGrid } from './culling.ts';
import lightVertex from './shaders/light.vert.glsl';
import lightFragment from './shaders/light.frag.glsl';
import rayVertex from './shaders/ray.vert.glsl';
import rayFragment from './shaders/ray.frag.glsl';
import fakeVertex from './shaders/lightfake.vert.glsl';
import fakeFragment from './shaders/lightfake.frag.glsl';
import haloVertex from './shaders/lighthalo.vert.glsl';
import haloFragment from './shaders/lighthalo.frag.glsl';
import reflectVertex from './shaders/reflect.vert.glsl';
import reflectFragment from './shaders/reflect.frag.glsl';
import { SIGNAL_GREEN, SIGNAL_YELLOW } from '../terrain/urban.ts';

/** The sphere is scaled by this beyond the light radius, so its coarse faces still enclose the light's reach. */
const VOLUME_SCALE = 1.12;
/** Overlap (m) of the deferred volumes and the overlay pools round their switch distance (the switch is decided by chunk centre). */
const LIGHT_SLACK = 65; // half the dither band (LIGHT_BAND) + half a chunk diagonal: the fade is decided per light, the culling per chunk
/** Half width (m) of the dithered cross-fade between the deferred volumes and the overlay pools. */
const LIGHT_BAND = 15;
/** Rays are drawn within this camera distance of their chunk. */
const SHAFT_DISTANCE = 260;
/** Same for the beams of a lighthouse (a little further than a lamp's: the lantern stands high). */
const TURNING_SHAFT_DISTANCE = 320;
/** Rays fade out over this many metres of lamp distance, ending at the distances above. */
const SHAFT_FADE_LENGTH = 80;
/** The chunk is culled this much further than the fade end (half a chunk diagonal), so a lamp is fully faded before its chunk goes. */
const SHAFT_CHUNK_SLACK = 50;

function shaftDistance(turning: boolean): number {
  return turning ? TURNING_SHAFT_DISTANCE : SHAFT_DISTANCE;
}
/** Widest half angle of a ray (the light's own cone is wider; rays read better narrow). */
const SHAFT_MAX_ANGLE = THREE.MathUtils.degToRad(30);
/** Wet-street reflections are drawn within this camera distance of their chunk centre: the shader's fade-out end
 *  (REFLECT_FADE_END in reflect.frag.glsl, 150 m) + half a chunk diagonal (~45 m), so close-up only. */
const REFLECT_DISTANCE = 195;

export interface LightDef {
  x: number;
  y: number;
  z: number;
  /** Reach in world units; the light fades to nothing at this distance. */
  radius: number;
  /** Linear colour. */
  color: THREE.Color;
  /** HDR multiplier on the colour. */
  intensity: number;
  /** Spot light: unit direction it shines along and half angle of its cone (radians). Omit both for a point light. */
  dir?: THREE.Vector3;
  angle?: number;
  /** Height of the ground the light mostly falls on; only the overlay quads of low quality use it. */
  groundY?: number;
  /** Lamp that shines to one side only (e.g. a signal head): unit horizontal direction it faces. Its wet-street
   *  reflection then only shows on ground in front of it. Omit for lamps that light all round. */
  facing?: THREE.Vector3;
  /** Traffic signal: [group, cycle offset]. Its colour follows the signal clock (red / yellow / green); `color` then only carries the brightness (use white). Needs a group made with `createGroup(true)`. */
  signal?: [number, number];
  /** Animated light (needs a group made with `createGroup(false, true)`, see chunks/anim.glsl): a beacon that flashes
   *  (lit for `duty` of every `period` seconds) or a spot light whose beam turns once per `period` (its `dir` then only
   *  gives the elevation). `phase` (s) offsets the clock. */
  anim?: { kind: 'blink' | 'rotate'; period: number; phase?: number; duty?: number };
  /** Strength of the light ray relative to the light (default 1): a long beam is marched over a long path, so it needs far less. */
  shaft?: number;
  /** Length (m) of the light ray along the spot axis when it should not run all the way to the ground (default: lamp height / axis dip). */
  rayLength?: number;
  /** Size (m) of the far halo disc when it should not follow the light's reach (default: reach x 0.12). */
  haloSize?: number;
  /** Shown only as a light ray (if it is a spot) and a far halo: no light volume, nothing is lit, no overlay pool at low quality. */
  rayOnly?: boolean;
  /** No far halo disc from this group: something else draws it (the street lamps of a town, in its city model). */
  noHalo?: boolean;
  /** Town (index into Terrain.cities) the light stands in: its volumes follow the town's detail level and its pool is drawn by the town's city model once that takes over (townLod.ts). */
  city?: number;
}

/** Per-instance [kind, period, phase, duty] of the animated lights of a chunk (see chunks/anim.glsl). */
function animAttribute(chunk: LightDef[]): THREE.InstancedBufferAttribute {
  const data = new Float32Array(chunk.length * 4);
  chunk.forEach((l, n) => {
    if (l.anim) data.set([l.anim.kind === 'blink' ? 1 : 2, l.anim.period, l.anim.phase ?? 0, l.anim.duty ?? 0.2], n * 4);
  });
  return new THREE.InstancedBufferAttribute(data, 4);
}

/** Per-instance town of the lights of a mesh (chunks/townfade.glsl): town index + 1 for the detailed lights, its negative for the city model's. */
export function townAttribute(count: number, value: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(new Float32Array(count).fill(value), 1);
}

/** Per-instance [group, offset] of the signal lights of a chunk (see chunks/signal.glsl). */
function signalAttribute(chunk: LightDef[]): THREE.InstancedBufferAttribute {
  const data = new Float32Array(chunk.length * 2);
  chunk.forEach((l, n) => data.set(l.signal ?? [0, 0], n * 2));
  return new THREE.InstancedBufferAttribute(data, 2);
}

/** Something bright mirrored by wet ground (reflect.*.glsl): a lamp, a lit window, a sign. */
export interface ReflectSpot {
  x: number;
  y: number;
  z: number;
  /** Ground height under it (the streak starts at its foot there). */
  groundY: number;
  /** How far over the ground the streak can land (culling box). */
  reach: number;
  /** Linear colour, HDR. */
  color: THREE.Color;
  /** One-sided (signal head, window, sign): unit horizontal direction it faces. Omit for things lit all round. */
  facing?: THREE.Vector3;
  /** Half width of the streak at the source (m); default 0.35 (a lamp). */
  halfWidth?: number;
}

/** Extra per-instance attribute of a reflection chunk mesh: item size and values for spot n. */
export type ReflectAttribute<T> = [size: number, (spot: T) => ArrayLike<number>];

/**
 * Wet-ground reflection streaks of a set of bright things, one InstancedMesh per chunk in the field's reflection scene
 * (post pass only, close-up only). Light groups make one for their lights; lit things that are no light (windows,
 * signs) make their own with `field.createReflections`, passing defines / uniforms for their shader branch.
 */
export class ReflectionGroup {
  /** Dimmer, 0-1. At 0 nothing is drawn. */
  level = 1;
  readonly material: THREE.ShaderMaterial;
  private meshes: THREE.InstancedMesh[] = [];
  private field: LightField;

  constructor(field: LightField, defines: Record<string, string>, uniforms: Record<string, THREE.IUniform>) {
    this.field = field;
    this.material = new THREE.ShaderMaterial({
      vertexShader: reflectVertex,
      fragmentShader: reflectFragment,
      defines,
      uniforms: { ...field.uniforms, ...field.groundUniforms, ...field.wetUniforms, level: { value: 1 }, ...uniforms },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
  }

  /**
   * Adds one chunk's streaks (instance n = spots[n]; hide one by zeroing its matrix) and returns the mesh. Call
   * `field.refresh()` once the chunks are added.
   */
  add<T extends ReflectSpot>(spots: T[], lodCenter: THREE.Vector3, extra: Record<string, ReflectAttribute<T>> = {}): THREE.InstancedMesh {
    const geo = this.field.quad.clone();
    const mesh = new THREE.InstancedMesh(geo, this.material, spots.length);
    const ground = new Float32Array(spots.length * 2);
    const facing = new Float32Array(spots.length * 3); // zero = lit all round
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    spots.forEach((s, n) => {
      ground.set([s.groundY, s.halfWidth ?? 0.35], n * 2);
      if (s.facing) facing.set([s.facing.x, 0, s.facing.z], n * 3);
      // Scale = reach: the culler's box then covers the ground the streak can land on.
      mesh.setMatrixAt(n, m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3().setScalar(s.reach)));
      mesh.setColorAt(n, s.color);
    });
    geo.setAttribute('aGround', new THREE.InstancedBufferAttribute(ground, 2));
    geo.setAttribute('aFacing', new THREE.InstancedBufferAttribute(facing, 3));
    for (const [name, [size, values]] of Object.entries(extra)) {
      const data = new Float32Array(spots.length * size);
      spots.forEach((s, n) => data.set(values(s), n * size));
      geo.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
    }
    mesh.userData.lodMax = REFLECT_DISTANCE;
    mesh.userData.lodCenter = lodCenter;
    this.meshes.push(mesh);
    this.field.reflectScene.add(mesh);
    return mesh;
  }

  /** Removes one chunk mesh made by `add` (call `field.refresh()` after). */
  remove(mesh: THREE.InstancedMesh): void {
    const i = this.meshes.indexOf(mesh);
    if (i < 0) return;
    this.meshes.splice(i, 1);
    this.field.reflectScene.remove(mesh);
    mesh.dispose();
    mesh.geometry.dispose();
  }

  clear(): void {
    for (const mesh of [...this.meshes]) this.remove(mesh);
  }

  /** After reflection culling: a group that is off draws no streaks. Returns how many streak meshes remain visible. */
  applyLevel(): number {
    this.material.uniforms.level.value = this.level;
    if (this.level > 0.001) return this.meshes.filter((m) => m.visible).length;
    for (const mesh of this.meshes) mesh.visible = false;
    return 0;
  }
}

/** A set of lights built together; see the file comment. */
export class LightGroup {
  private dimmer = 1;
  private material: THREE.ShaderMaterial;
  private meshes: THREE.InstancedMesh[] = [];
  /** Low-quality stand-ins (glow + ground pool quads), one pair per chunk. */
  private fake: THREE.InstancedMesh[] = [];
  private fakeMaterials: THREE.ShaderMaterial[];
  /** Far-away look: a bright disc per light that fades in with camera distance (all qualities). */
  private halos: THREE.InstancedMesh[] = [];
  private haloMaterial: THREE.ShaderMaterial;
  /** Light-shaft cones of spot lights (quality setting), in the main scene. */
  private shafts: THREE.InstancedMesh[] = [];
  private shaftMaterial: THREE.ShaderMaterial;
  /** Wet-street reflection streaks, one quad per light (post pass only). */
  private reflections: ReflectionGroup;
  private field: LightField;
  /** Lights change colour with the signal clock (see chunks/signal.glsl). */
  private signals: boolean;
  /** Lights flash / turn on the render clock (LightDef.anim, see chunks/anim.glsl). */
  private animated: boolean;

  constructor(field: LightField, signals = false, animated = false) {
    this.field = field;
    this.signals = signals;
    this.animated = animated;
    const sig: Record<string, THREE.IUniform> = {
      ...(signals ? { signalGreen: { value: SIGNAL_GREEN }, signalYellow: { value: SIGNAL_YELLOW } } : {}),
      ...(signals || animated ? { time: field.uniforms.time } : {}),
    };
    const view = { fogOrigin: field.uniforms.fogOrigin, gameRight: field.uniforms.gameRight, gameUp: field.uniforms.gameUp, townInfo: field.uniforms.townInfo, tNoise: field.uniforms.tNoise, lightSwitch: field.uniforms.lightSwitch };
    const sigDefine: Record<string, string> = { ...(signals ? { SIGNAL: '' } : {}), ...(animated ? { ANIM: '' } : {}) };
    this.reflections = field.createReflections(sigDefine, sig);
    this.material = new THREE.ShaderMaterial({
      vertexShader: lightVertex,
      fragmentShader: lightFragment,
      defines: { VOLUME_SCALE: VOLUME_SCALE.toFixed(3), LIGHT_SWITCH: '1.0', ...sigDefine },
      uniforms: { ...field.uniforms, ...sig, level: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    const fakeMaterial = (defines: Record<string, string>) =>
      new THREE.ShaderMaterial({
        vertexShader: fakeVertex,
        fragmentShader: fakeFragment,
        defines: { ...defines, LIGHT_SWITCH: '-1.0', ...sigDefine },
        uniforms: { level: this.material.uniforms.level, ...field.groundUniforms, ...sig, ...view },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
    this.fakeMaterials = [fakeMaterial({}), fakeMaterial({ FLAT: '' })];
    this.haloMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      defines: sigDefine,
      uniforms: { level: this.material.uniforms.level, haloStart: { value: 0 }, haloEnd: { value: 1 }, time: field.uniforms.time, haloBokeh: field.uniforms.haloBokeh, ...sig, ...view },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.shaftMaterial = new THREE.ShaderMaterial({
      vertexShader: rayVertex,
      fragmentShader: rayFragment,
      defines: {
        VOLUME_SCALE: VOLUME_SCALE.toFixed(3),
        SHAFT_FADE_START: (shaftDistance(animated) - SHAFT_FADE_LENGTH).toFixed(1),
        SHAFT_FADE_END: shaftDistance(animated).toFixed(1),
        ...(animated ? { ANIM: '' } : {}),
      },
      uniforms: { ...field.uniforms, level: this.material.uniforms.level },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
  }

  /** Dimmer, 0-1. A group at 0 is skipped entirely. */
  get level(): number {
    return this.dimmer;
  }

  set level(value: number) {
    this.dimmer = value;
    this.reflections.level = value;
  }

  /** Replaces the group's lights: one InstancedMesh per map chunk that has any. */
  build(lights: LightDef[], grid: ChunkGrid): void {
    this.clear();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    const townLod = this.field.townLod;
    /** Lights standing in a town, per town: its city model draws their pools in one mesh once the town is far. */
    const townLights = new Map<number, LightDef[]>();
    for (const [key, all] of groupByChunk(lights, grid)) {
      // A chunk's lights of one town are separate meshes: they are hidden when the town's city model takes over (townLod.ts).
      const parts = new Map<number, LightDef[]>();
      for (const l of all) {
        const city = townLod && l.city !== undefined && l.city >= 0 ? l.city : -1;
        const part = parts.get(city);
        if (part) part.push(l);
        else parts.set(city, [l]);
      }
      for (const [city, chunk] of parts) {
        // Lights that only show as ray + halo (`ray`) get no light volume (nothing is lit by them), only their ray and halo.
        const lit = chunk.filter((l) => !l.rayOnly);
        if (lit.length) {
          const geo = this.field.volume.clone();
          const spots = new Float32Array(lit.length * 4);
          const mesh = new THREE.InstancedMesh(geo, this.material, lit.length);
          lit.forEach((l, n) => {
            m.compose(new THREE.Vector3(l.x, l.y, l.z), q, scale.setScalar(l.radius * VOLUME_SCALE));
            mesh.setMatrixAt(n, m);
            mesh.setColorAt(n, color.copy(l.color).multiplyScalar(l.intensity));
            if (l.dir && l.angle !== undefined) spots.set([l.dir.x, l.dir.y, l.dir.z, Math.cos(l.angle)], n * 4);
            else spots[n * 4 + 3] = -2;
          });
          geo.setAttribute('aSpot', new THREE.InstancedBufferAttribute(spots, 4));
          if (this.signals) geo.setAttribute('aSignal', signalAttribute(lit));
          if (this.animated) geo.setAttribute('aAnim', animAttribute(lit));
          if (city >= 0) geo.setAttribute('aTown', townAttribute(lit.length, city + 1));
          mesh.userData.lodCenter = grid.center(key);
          if (city >= 0) townLod!.tag(mesh, city);
          this.meshes.push(mesh);
          this.field.scene.add(mesh);
        }
        this.buildFake(chunk, key, grid, city);
        this.buildShafts(chunk, key, grid);
        this.buildReflections(chunk, key, grid);
        if (city >= 0) {
          const list = townLights.get(city);
          if (list) list.push(...chunk);
          else townLights.set(city, [...chunk]);
        }
      }
    }
    for (const [city, list] of townLights) this.buildTownPools(list, city);
    this.applyDistances();
    this.field.refresh();
  }

  /**
   * Deferred volumes cover only the lights near the camera; the cheap overlay pools (the low-quality lighting) take over
   * beyond `distance`. Town lights follow their town instead (tagged meshes, townLod.ts): volumes / chunk pools while the
   * town is near, one pool mesh per town once its city model is drawn. Low quality (no deferred) draws pools everywhere.
   */
  applyDistances(): void {
    const { deferred, deferredDistance } = this.field;
    this.field.uniforms.lightSwitch.value = new THREE.Vector2(deferred ? deferredDistance : 0, LIGHT_BAND);
    for (const mesh of this.meshes) {
      if (mesh.userData.townCity === undefined) mesh.userData.lodMax = deferred ? deferredDistance + LIGHT_SLACK : undefined;
    }
    for (const mesh of this.fake) {
      if (mesh.userData.townRole === 'model') continue; // the town's city-model pools: always beyond its switch
      if (mesh.userData.townCity !== undefined) mesh.userData.lodMin = deferred ? Infinity : undefined; // chunk pools of town lights: only where there are no volumes
      else mesh.userData.lodMin = deferred ? deferredDistance - LIGHT_SLACK : undefined;
    }
  }

  /** One reflection streak quad per light of the chunk (see reflect.vert.glsl). */
  private buildReflections(chunk: LightDef[], key: number, grid: ChunkGrid): void {
    // Flashing / turning lights have no steady streak on the ground.
    const spots = chunk.filter((l) => !l.anim).map((l) => ({
      x: l.x, y: l.y, z: l.z, groundY: l.groundY ?? l.y - l.radius * 0.25, reach: l.radius,
      color: l.color.clone().multiplyScalar(l.intensity), facing: l.facing, signal: l.signal ?? [0, 0],
    }));
    if (!spots.length) return;
    this.reflections.add(spots, grid.center(key), this.signals ? { aSignal: [2, (s) => s.signal] } : {});
  }

  /** One flat pool quad per light (see lightfake.vert.glsl), as one InstancedMesh. */
  private poolMesh(lights: LightDef[], town: number): THREE.InstancedMesh {
    const none = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    // Signal lights need their own per-instance attribute, so the shared geometry is cloned.
    const own = this.signals || this.animated;
    const grid = town < 0 ? this.field.poolGridFar : this.field.poolGrid; // town < 0: the city model's pools
    let poolGeo = own ? grid.clone() : grid;
    if (this.signals) poolGeo.setAttribute('aSignal', signalAttribute(lights));
    if (this.animated) poolGeo.setAttribute('aAnim', animAttribute(lights));
    // A town's pools cross-fade with the town's volumes / city model (`town` = index + 1, or its negative for the city model's).
    if (town !== 0) {
      if (!own) poolGeo = poolGeo.clone();
      poolGeo.setAttribute('aTown', townAttribute(lights.length, town));
    }
    const pools = new THREE.InstancedMesh(poolGeo, this.fakeMaterials[1], lights.length);
    lights.forEach((l, n) => {
      const groundY = l.groundY ?? l.y - l.radius * 0.25;
      const height = Math.max(1, l.y - groundY);
      // Where the light lands: along the spot axis down to the ground, or straight below a point light.
      const pool = new THREE.Vector3(l.x, groundY, l.z);
      let poolRadius = l.radius * 0.55;
      if (l.dir && l.angle !== undefined) {
        if (l.dir.y < -0.1) pool.set(l.x + (l.dir.x / -l.dir.y) * height, groundY, l.z + (l.dir.z / -l.dir.y) * height);
        poolRadius = Math.min(l.radius * 0.6, height * Math.tan(l.angle));
      }
      color.copy(l.color).multiplyScalar(l.intensity);
      pools.setMatrixAt(n, m.compose(pool.setY(groundY), none, new THREE.Vector3().setScalar(poolRadius * 2))); // height follows the ground in the shader
      pools.setColorAt(n, l.rayOnly ? color.setScalar(0) : color);
    });
    pools.userData.noShadow = true;
    pools.userData.ownGeometry = own || town !== 0; // cloned for this mesh: disposed with it
    pools.renderOrder = 2;
    return pools;
  }

  /**
   * All pools of a town's lights in ONE mesh, drawn once the town's city model is (beyond its switch distance), at every
   * quality: the low-quality lighting stands in for the deferred volumes there.
   */
  private buildTownPools(lights: LightDef[], city: number): void {
    const pools = this.poolMesh(lights, -(city + 1));
    this.field.townLod!.tag(pools, city, 'model');
    this.fake.push(pools);
    this.field.fakeGroup.add(pools);
  }

  /** One glow disc (far halo) and one flat pool quad per light of the chunk; `city` >= 0: lights of that town (see lightfake.vert.glsl). */
  private buildFake(chunk: LightDef[], key: number, grid: ChunkGrid, city: number): void {
    const none = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    const own = this.signals || this.animated;
    // Lights flagged `noHalo` have their far disc somewhere else (the town's city model, cityLod.ts).
    const haloLights = chunk.filter((l) => !l.noHalo);
    const haloGeo = own ? this.field.quad.clone() : this.field.quad;
    if (this.signals) haloGeo.setAttribute('aSignal', signalAttribute(haloLights));
    if (this.animated) haloGeo.setAttribute('aAnim', animAttribute(haloLights));
    const halos = haloLights.length ? new THREE.InstancedMesh(haloGeo, this.haloMaterial, haloLights.length) : null;
    if (!halos && own) haloGeo.dispose();
    const pools = this.poolMesh(chunk, city >= 0 ? city + 1 : 0);
    if (city >= 0) this.field.townLod!.tag(pools, city);
    if (halos) {
      haloLights.forEach((l, n) => {
        halos.setMatrixAt(n, m.compose(new THREE.Vector3(l.x, l.y, l.z), none, new THREE.Vector3().setScalar(l.haloSize ?? Math.max(1.5, l.radius * 0.12))));
        halos.setColorAt(n, color.copy(l.color).multiplyScalar(l.intensity));
      });
      halos.userData.lodCenter = grid.center(key);
      halos.userData.lodMax = this.haloMax || undefined;
      halos.userData.noShadow = true;
      halos.renderOrder = 2; // after roads (~0.5-1) and water, so they never paint over the discs
      this.halos.push(halos);
      this.field.haloGroup.add(halos);
    }
    pools.userData.lodCenter = grid.center(key);
    this.fake.push(pools);
    this.field.fakeGroup.add(pools);
  }

  /** One ray volume per spot light of the chunk: a sphere round the beam from the lamp along the spot axis down to the ground. */
  private buildShafts(chunk: LightDef[], key: number, grid: ChunkGrid): void {
    const spots = chunk.filter((l) => l.dir && l.angle !== undefined && l.dir.y < -0.1);
    if (!spots.length) return;
    const geo = this.field.volume.clone();
    const mesh = new THREE.InstancedMesh(geo, this.shaftMaterial, spots.length);
    const rayA = new Float32Array(spots.length * 4);
    const rayB = new Float32Array(spots.length * 4);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    spots.forEach((l, n) => {
      const groundY = l.groundY ?? l.y - l.radius * 0.25;
      const length = l.rayLength ?? Math.max(1, l.y - groundY) / -l.dir!.y;
      const tanHalf = Math.tan(Math.min(l.angle! * 0.5, SHAFT_MAX_ANGLE));
      const d = l.dir!;
      rayA.set([l.x, l.y, l.z, length], n * 4);
      rayB.set([d.x, d.y, d.z, tanHalf], n * 4);
      // Bounding sphere of the cone: centred half way down the axis, reaching the rim of the base. A turning beam
      // sweeps a whole circle, so its sphere is centred on the lamp and as wide as the beam is long.
      const turns = l.anim?.kind === 'rotate';
      const reach = turns ? Math.hypot(length, tanHalf * length) : Math.hypot(length / 2, tanHalf * length);
      const mid = turns ? 0 : length / 2;
      m.compose(
        new THREE.Vector3(l.x + d.x * mid, l.y + d.y * mid, l.z + d.z * mid),
        q,
        new THREE.Vector3().setScalar(reach * VOLUME_SCALE),
      );
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, color.copy(l.color).multiplyScalar(l.intensity * (l.shaft ?? 1)));
    });
    geo.setAttribute('aRayA', new THREE.InstancedBufferAttribute(rayA, 4));
    geo.setAttribute('aRayB', new THREE.InstancedBufferAttribute(rayB, 4));
    if (this.animated) geo.setAttribute('aAnim', animAttribute(spots));
    // Lighthouse beams reach far: seen from much further than a street lamp's cone.
    mesh.userData.lodMax = shaftDistance(spots.some((l) => l.anim?.kind === 'rotate')) + SHAFT_CHUNK_SLACK;
    mesh.userData.lodCenter = grid.center(key);
    this.shafts.push(mesh);
    this.field.shaftScene.add(mesh);
  }

  clear(): void {
    this.reflections.clear();
    for (const mesh of this.shafts) {
      this.field.shaftScene.remove(mesh);
      mesh.dispose();
      mesh.geometry.dispose();
    }
    this.shafts = [];
    for (const mesh of this.meshes) {
      this.field.scene.remove(mesh);
      mesh.dispose();
      mesh.geometry.dispose();
    }
    this.meshes = [];
    for (const mesh of this.fake) {
      this.field.fakeGroup.remove(mesh);
      mesh.dispose();
      if (mesh.userData.ownGeometry) mesh.geometry.dispose(); // cloned per mesh (shared otherwise)
    }
    this.fake = [];
    for (const mesh of this.halos) {
      this.field.haloGroup.remove(mesh);
      mesh.dispose();
      if (this.signals || this.animated) mesh.geometry.dispose();
    }
    this.halos = [];
    this.field.refresh();
  }

  /** Camera distance (to the chunk centre) beyond which this group's far discs are no longer drawn (0 = never). */
  setHaloMax(distance: number): void {
    this.haloMax = distance;
    for (const mesh of this.halos) mesh.userData.lodMax = distance || undefined;
  }

  private haloMax = 0;

  /** Camera distances where the far discs start to fade in and where they are at full strength. */
  setHaloRange(start: number, end: number): void {
    this.haloMaterial.uniforms.haloStart.value = start;
    this.haloMaterial.uniforms.haloEnd.value = end;
  }

  /** After ray culling: a group that is off draws no rays. Returns how many ray meshes remain visible. */
  applyShaftLevel(): number {
    if (this.level > 0.001) return this.shafts.filter((m) => m.visible).length;
    for (const mesh of this.shafts) mesh.visible = false;
    return 0;
  }

  /** After halo culling: a group that is off draws no discs. */
  applyHaloLevel(): void {
    if (this.level > 0.001) return;
    for (const mesh of this.halos) mesh.visible = false;
  }

  /** Called by the field after culling: groups that are off draw nothing. Returns how many chunk meshes remain visible. */
  applyLevel(fake: boolean): number {
    this.material.uniforms.level.value = this.level;
    const meshes = fake ? this.fake : this.meshes;
    if (this.level > 0.001) return meshes.filter((m) => m.visible).length;
    for (const mesh of meshes) mesh.visible = false;
    return 0;
  }
}

/** All light groups plus the shared state of the light pass. Owned by the World, drawn by Lighting. */
export class LightField {
  readonly scene = new THREE.Scene();
  /** Uniforms shared by every group's material; Lighting fills the per-frame ones. */
  readonly uniforms: Record<string, { value: unknown }> & { tDepth: { value: THREE.Texture | null }; invViewProj: { value: THREE.Matrix4 }; resolution: { value: THREE.Vector2 }; fogNear: { value: number }; fogFar: { value: number }; tNoise: { value: THREE.Texture | null }; rayResolution: { value: THREE.Vector2 } } = {
    fogOrigin: { value: new THREE.Vector3() },
    gameRight: { value: new THREE.Vector3(1, 0, 0) },
    gameUp: { value: new THREE.Vector3(0, 1, 0) },
    tDepth: { value: null as THREE.Texture | null },
    invViewProj: { value: new THREE.Matrix4() },
    resolution: { value: new THREE.Vector2(1, 1) },
    fogNear: { value: 400 },
    fogFar: { value: 1200 },
    time: { value: 0 },
    haloBokeh: { value: 0 },
    /** Per town, two entries: (centre x, y, z, switch distance), (band half width, 0, 0, 0) (the World points this at TownLod.info; chunks/townfade.glsl). */
    townInfo: { value: [] as THREE.Vector4[] },
    tNoise: { value: null as THREE.Texture | null },
    /** Switch distance and band half width between the deferred volumes and the overlay pools (chunks/townfade.glsl); x = 0: no switch. */
    lightSwitch: { value: new THREE.Vector2() },
    rayResolution: { value: new THREE.Vector2(1, 1) },
    lightResolution: { value: new THREE.Vector2(1, 1) },
  };
  /** Unit sphere every group clones for its chunk meshes. */
  readonly volume = new THREE.IcosahedronGeometry(1, 1);
  /** Overlay quads of the low-quality mode; they live in the main scene (the engine adds this group to it). */
  readonly fakeGroup = new THREE.Group();
  /** Far-away light discs; drawn in the main scene at every quality (the engine adds this group to it). */
  readonly haloGroup = new THREE.Group();
  private haloCuller = new Culler();
  /** Ray volumes, drawn into their own half-resolution target (see Lighting). */
  readonly shaftScene = new THREE.Scene();
  private shaftCuller = new Culler();
  private shaftsOn = false;
  /** Wet-street reflection streaks, drawn into the ray target too (see Lighting). */
  readonly reflectScene = new THREE.Scene();
  private reflectCuller = new Culler();
  private reflectOn = false;
  /** Wet mask of the current map (wetmask.ts), shared by the reflection materials. */
  readonly wetUniforms = {
    tWet: { value: null as THREE.Texture | null },
    wetSize: { value: 1 },
  };
  /** Unit quad shared by the glow overlays. */
  readonly quad = new THREE.PlaneGeometry(1, 1);
  /** Unit horizontal grid for the ground pools: the vertex shader drapes it over the terrain heights. */
  readonly poolGrid = new THREE.PlaneGeometry(1, 1, 4, 4).rotateX(-Math.PI / 2); // 4x4 cells (32 triangles): a soft pool of a few metres drapes fine on that
  /** The pools of a town's city model (seen from far away, streets are flat): 2x2 cells, a town has a thousand lamps. */
  readonly poolGridFar = new THREE.PlaneGeometry(1, 1, 2, 2).rotateX(-Math.PI / 2);
  /** Height texture of the rendered ground (see World), shared by the pool materials. */
  readonly groundUniforms = {
    tHeight: { value: null as THREE.Texture | null },
    mapSize: { value: 1 },
    gridSize: { value: 1 },
  };
  private deferredOn = true;
  /** Camera distance (to the chunk centre) beyond which the cheap overlay pools replace the deferred volumes. */
  private deferredRange = 400;
  /** Town LOD (set by the World): town lights follow their town's detail level. */
  townLod: TownLod | null = null;
  private groups: LightGroup[] = [];
  private reflectGroups: ReflectionGroup[] = [];
  private culler = new Culler();
  private fakeCuller = new Culler();

  get deferred(): boolean {
    return this.deferredOn;
  }

  get deferredDistance(): number {
    return this.deferredRange;
  }

  /** `signals`: the group's lights are traffic signals (LightDef.signal). `animated`: its lights flash or turn (LightDef.anim). */
  createGroup(signals = false, animated = false): LightGroup {
    const group = new LightGroup(this, signals, animated);
    this.groups.push(group);
    return group;
  }

  /**
   * Wet-ground reflections of lit things that are no LightDef (windows, signs); light groups make their own. `defines`
   * / `uniforms` select and feed a branch of reflect.vert.glsl (e.g. WINDOW).
   */
  createReflections(defines: Record<string, string> = {}, uniforms: Record<string, THREE.IUniform> = {}): ReflectionGroup {
    const group = new ReflectionGroup(this, defines, uniforms);
    this.reflectGroups.push(group);
    return group;
  }

  /** Seconds, for the animated light rays. */
  setTime(seconds: number): void {
    this.uniforms.time.value = seconds;
  }

  setFog(near: number, far: number, origin: THREE.Vector3): void {
    this.uniforms.fogOrigin.value = origin;
    this.uniforms.fogNear.value = near;
    this.uniforms.fogFar.value = far;
  }

  /** The ground's height texture and size, so overlay pools can follow the terrain (see lightfake.vert.glsl). */
  setGround(heights: THREE.Texture, mapSize: number, gridSize: number): void {
    this.groundUniforms.tHeight.value = heights;
    this.groundUniforms.mapSize.value = mapSize;
    this.groundUniforms.gridSize.value = gridSize;
  }

  /** Deferred light volumes for the lights near the camera (true; the overlay pools take over beyond `setDeferredDistance`), or the cheap overlay quads everywhere (false). */
  setDeferred(on: boolean): void {
    this.deferredOn = on;
    for (const g of this.groups) g.applyDistances();
  }

  /** Camera distance beyond which the overlay pools replace the deferred volumes (town lights follow their town instead). */
  setDeferredDistance(distance: number): void {
    this.deferredRange = distance;
    for (const g of this.groups) g.applyDistances();
  }

  /** Light shafts on / off (high quality). */
  setShafts(on: boolean): void {
    this.shaftsOn = on;
  }

  /** Bokeh on far light halos on / off (ultra): they open into soft out-of-focus discs (gameview.glsl `bokehAmount`). */
  setBokeh(on: boolean): void {
    this.uniforms.haloBokeh.value = on ? 1 : 0;
  }

  /** Wet-street reflections on / off (needs the post pass). */
  setReflections(on: boolean): void {
    this.reflectOn = on;
  }

  /** The current map's wet mask (wetmask.ts) covering `worldSize` (null = none yet); the previous one is disposed. */
  setWetMask(mask: THREE.Texture | null, worldSize: number): void {
    this.wetUniforms.tWet.value?.dispose();
    this.wetUniforms.tWet.value = mask;
    this.wetUniforms.wetSize.value = worldSize;
  }

  /** Culls the reflection streaks. Returns how many will be drawn (0 until the map's wet mask exists). */
  cullReflections(camera: THREE.Camera): number {
    if (!this.reflectOn || !this.wetUniforms.tWet.value) return 0;
    this.reflectCuller.update(camera);
    let drawn = 0;
    for (const g of this.reflectGroups) drawn += g.applyLevel();
    return drawn;
  }

  /** Culls the ray volumes. Returns how many will be drawn. */
  cullShafts(camera: THREE.Camera): number {
    if (!this.shaftsOn) return 0;
    this.shaftCuller.update(camera);
    let drawn = 0;
    for (const g of this.groups) drawn += g.applyShaftLevel();
    return drawn;
  }

  /** Re-registers the chunk meshes with the cullers (after any group was rebuilt). */
  refresh(): void {
    this.culler.clear();
    this.culler.collect(this.scene);
    this.fakeCuller.clear();
    this.fakeCuller.collect(this.fakeGroup);
    this.shaftCuller.clear();
    this.shaftCuller.collect(this.shaftScene);
    this.reflectCuller.clear();
    this.reflectCuller.collect(this.reflectScene);
    this.haloCuller.clear();
    this.haloCuller.collect(this.haloGroup);
  }

  /**
   * Culls the overlay pools (drawn in the main scene, so before it): all of them in low quality, only the far ones (and the
   * town models') with deferred lights. Returns how many will be drawn.
   */
  cullOverlay(camera: THREE.Camera): number {
    this.fakeCuller.update(camera);
    let drawn = 0;
    for (const g of this.groups) drawn += g.applyLevel(true);
    return drawn;
  }

  /** Frustum / distance culling of the halos and, with deferred lights, the light volumes. Returns how many volume meshes will be drawn. */
  cull(camera: THREE.Camera): number {
    if (this.deferredOn) this.culler.update(camera);
    this.haloCuller.update(camera);
    for (const g of this.groups) g.applyHaloLevel();
    let drawn = 0;
    if (this.deferredOn) for (const g of this.groups) drawn += g.applyLevel(false);
    return drawn;
  }
}
