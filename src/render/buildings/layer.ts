// Building layer: per map chunk one near (detailed) and one far (simple) merged mesh, switched by camera distance,
// plus window-light halos for the far view at night and the gas stations' canopy lights.
//
// Destruction (BuildingState) never rebuilds a mesh: every building's vertices are a known range of its chunk's
// buffers, so destroying one collapses its body range and restores its rubble range (and the reverse when
// repaired), a small buffer update. Done on the CPU so the shadow pass (which draws with its own material) agrees.

import * as THREE from 'three';
import { hash32 } from '../../core/rng.ts';
import { BuildingState, buildingSpec, type Building } from '../../terrain/generate.ts';
import type { Environment } from '../world.ts';
import { groupByChunk, type ChunkGrid } from '../culling.ts';
import type { LightDef, LightField, LightGroup, ReflectionGroup, ReflectSpot } from '../lights.ts';
import { CRANE_APEX_BEACON, CRANE_JIB_BEACON, MeshData, buildFar, buildNear, buildRubble, glowSpots, haloSpots, toWorld, windowSeed, type Span } from './geometry.ts';
import nearVertex from '../shaders/building.vert.glsl';
import nearFragment from '../shaders/building.frag.glsl';
import farVertex from '../shaders/buildingFar.vert.glsl';
import farFragment from '../shaders/buildingFar.frag.glsl';
import haloVertex from '../shaders/buildingHalo.vert.glsl';
import haloFragment from '../shaders/lighthalo.frag.glsl';

/** Window lights switch on as the sky darkens (same curve as the street lights). */
const ON_DAYLIGHT = 0.65;
const OFF_DAYLIGHT = 0.25;
/** Window halo colour (linear) and disc size (m). */
const HALO_COLOR = new THREE.Color().setRGB(1.0, 0.62, 0.3, THREE.LinearSRGBColorSpace).multiplyScalar(0.55);
const HALO_SIZE = 0.9;
/** Wet-ground reflections of lit windows (white x the window's own colour in the shader) and signs (x their colour). */
const WINDOW_REFLECT = 1.6;
const SIGN_REFLECT = 1.4;
/** Crane beacons: flashing red aviation lights at the jib tip and the apex (linear colour x intensity, reach, flash cycle and lit share). */
const BEACON_COLOR = new THREE.Color().setRGB(1.0, 0.05, 0.03, THREE.LinearSRGBColorSpace);
const BEACON_INTENSITY = 3.5;
const BEACON_RADIUS = 16;
const BEACON_PERIOD = 1.4;
const BEACON_DUTY = 0.22;
/** Beacons keep this share of their strength by day (the flash still reads); full at night. */
const BEACON_DAY_LEVEL = 0.4;

/** Instances of one building in a chunk's instanced mesh (halos, reflections) and their matrices, to hide / restore. */
interface Instances {
  index: number[];
  matrices: THREE.Matrix4[];
}

/** A window / sign streak of a chunk (ReflectSpot + its WINDOW attributes, reflect.vert.glsl). */
interface GlowReflection extends ReflectSpot {
  key: number[];
  share: number;
}

/** One chunk's meshes and where each of its buildings lives in them. */
interface Chunk {
  near: THREE.Mesh;
  far: THREE.Mesh;
  halos: THREE.InstancedMesh | null;
  reflections: THREE.InstancedMesh | null;
  /** Untouched positions, to restore collapsed ranges. */
  nearBase: Float32Array;
  farBase: Float32Array;
  spans: Map<number, { near: Span; nearRubble: Span; far: Span; farRubble: Span; halos: Instances; reflections: Instances }>;
}

export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly nearMaterial: THREE.ShaderMaterial;
  readonly farMaterial: THREE.ShaderMaterial;
  private haloMaterial: THREE.ShaderMaterial;
  private haloGroup = new THREE.Group();
  private quad = new THREE.PlaneGeometry(1, 1);
  private chunks = new Map<number, Chunk>();
  /** Chunk of each building id. */
  private chunkOf = new Map<number, Chunk>();
  private buildings: Building[] = [];
  private lights: LightGroup;
  /** Flashing red beacons of the construction cranes (animated group). */
  private beacons: LightGroup;
  /** Wet-ground streaks of lit windows and signs (post pass, close up). */
  private reflections: ReflectionGroup;
  private field: LightField;
  private lightsBuilt = false;
  private grid: ChunkGrid | null = null;
  private level = -1;
  /** Chunks nearer than this to the camera draw the detailed meshes. */
  private lodDistance = 300;
  private unsubscribe: (() => void) | null = null;
  /** Destroyed bits of the current map's buildings (null before its buildings arrive). */
  state: BuildingState | null = null;

  constructor(env: Environment, field: LightField) {
    this.field = field;
    this.lights = field.createGroup();
    this.beacons = field.createGroup(false, true);
    this.reflections = field.createReflections({ WINDOW: '' }, { hour: env.hour });
    this.reflections.level = 0;
    const uniforms = () => ({
      sunDir: { value: env.sunDir },
      sunColor: { value: env.sunColor },
      skyAmbient: { value: env.skyAmbient },
      groundAmbient: { value: env.groundAmbient },
      ...env.fog,
      fogNear: { value: 400 },
      fogFar: { value: 1200 },
      lampLevel: { value: 0 },
      hour: env.hour,
      time: field.uniforms.time,
    });
    this.nearMaterial = new THREE.ShaderMaterial({ vertexShader: nearVertex, fragmentShader: nearFragment, vertexColors: true, uniforms: uniforms() });
    this.farMaterial = new THREE.ShaderMaterial({ vertexShader: farVertex, fragmentShader: farFragment, vertexColors: true, uniforms: uniforms() });
    this.haloMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      uniforms: {
        level: { value: 0 }, haloStart: { value: 0 }, haloEnd: { value: 1 }, hour: env.hour, time: field.uniforms.time, haloBokeh: field.uniforms.haloBokeh,
        fogOrigin: field.uniforms.fogOrigin, gameRight: field.uniforms.gameRight, gameUp: field.uniforms.gameUp,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.group.add(this.haloGroup);
    this.setHaloRange();
  }

  get materials(): THREE.ShaderMaterial[] {
    return [this.nearMaterial, this.farMaterial];
  }

  /**
   * Takes the map's buildings: makes a fresh BuildingState for them and returns one build job per chunk
   * (key, chunk centre for nearest-first ordering, run). `buildLights` should run after them.
   */
  setBuildings(buildings: Building[], grid: ChunkGrid): { key: number; at: THREE.Vector3; run: () => void }[] {
    this.clear();
    this.buildings = buildings;
    this.grid = grid;
    this.setState(new BuildingState(buildings.length));
    return [...groupByChunk(buildings, grid)].map(([key, list]) => ({ key, at: grid.center(key), run: () => this.buildChunk(key, list) }));
  }

  /** Follows another state object (e.g. one kept in sync over the network); applies its bits at once. */
  setState(state: BuildingState): void {
    this.unsubscribe?.();
    this.state = state;
    this.unsubscribe = state.onChange((id, destroyed) => this.apply(id, destroyed));
    for (const b of this.buildings) this.apply(b.id, state.isDestroyed(b.id));
  }

  private buildChunk(key: number, list: Building[]): void {
    const grid = this.grid!;
    const near = new MeshData({ aWin: 2, aKey: 4 });
    const far = new MeshData({ aFacade: 4, aGrid: 4, aCols: 4, aDoor: 4, aSeed: 1, aGlass: 3 });
    const spans: Chunk['spans'] = new Map();
    const halos: { id: number; m: THREE.Matrix4; key: number[]; share: number }[] = [];
    const glows: GlowReflection[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (const b of list) {
      const spec = buildingSpec(b.seed, b.type);
      const span = (data: MeshData, fn: () => void): Span => {
        const start = data.vertexCount;
        fn();
        return { start, count: data.vertexCount - start };
      };
      const entry = {
        near: span(near, () => buildNear(near, b, spec)),
        nearRubble: span(near, () => buildRubble(near, b, spec, false)),
        far: span(far, () => buildFar(far, b, spec)),
        farRubble: span(far, () => buildRubble(far, b, spec, true)),
        halos: { index: [], matrices: [] } as Instances,
        reflections: { index: [], matrices: [] } as Instances,
      };
      const seed = windowSeed(b);
      for (const spot of haloSpots(b, spec)) {
        const [x, y, z] = toWorld(b, spot.pos);
        const matrix = m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3().setScalar(HALO_SIZE)).clone();
        entry.halos.index.push(halos.length);
        entry.halos.matrices.push(matrix);
        halos.push({ id: b.id, m: matrix, key: [...spot.key, seed], share: spec.litShare });
      }
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      for (const spot of glowSpots(b, spec)) {
        const [x, y, z] = toWorld(b, spot.pos);
        const reach = 6 + 3 * (y - b.y); // the fragment shader's fall-off length
        entry.reflections.index.push(glows.length);
        entry.reflections.matrices.push(m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3().setScalar(reach)).clone());
        glows.push({
          x, y, z, groundY: b.y, reach, halfWidth: spot.halfWidth,
          facing: new THREE.Vector3(spot.out[0] * c + spot.out[2] * s, 0, -spot.out[0] * s + spot.out[2] * c),
          color: spot.key ? new THREE.Color(WINDOW_REFLECT, WINDOW_REFLECT, WINDOW_REFLECT) : new THREE.Color(spot.color).multiplyScalar(SIGN_REFLECT),
          key: [...(spot.key ?? [0, 0, 0]), seed],
          share: spot.key ? spec.litShare : -1,
        });
      }
      spans.set(b.id, entry);
    }

    const lodCenter = grid.center(key);
    const nearMesh = new THREE.Mesh(near.toGeometry(), this.nearMaterial);
    nearMesh.userData.lodMax = this.lodDistance;
    nearMesh.userData.lodCenter = lodCenter;
    // Each level casts the shadows while it is the one drawn (the shadow pass picks levels from the main camera).
    const farMesh = new THREE.Mesh(far.toGeometry(), this.farMaterial);
    farMesh.userData.lodMin = this.lodDistance;
    farMesh.userData.lodCenter = lodCenter;
    let haloMesh: THREE.InstancedMesh | null = null;
    if (halos.length) {
      // Own quad per chunk: it carries the halos' window keys as instance attributes.
      const quad = this.quad.clone();
      quad.setAttribute('aHalo', new THREE.InstancedBufferAttribute(new Float32Array(halos.flatMap((h) => h.key)), 4));
      quad.setAttribute('aHaloShare', new THREE.InstancedBufferAttribute(new Float32Array(halos.map((h) => h.share)), 1));
      haloMesh = new THREE.InstancedMesh(quad, this.haloMaterial, halos.length);
      halos.forEach((h, i) => {
        haloMesh!.setMatrixAt(i, h.m);
        haloMesh!.setColorAt(i, HALO_COLOR);
      });
      haloMesh.userData.noShadow = true;
      haloMesh.userData.lodCenter = lodCenter;
      haloMesh.renderOrder = 2;
      this.haloGroup.add(haloMesh);
    }
    const reflections = glows.length
      ? this.reflections.add(glows, lodCenter, { aHalo: [4, (g) => g.key], aHaloShare: [1, (g) => [g.share]] })
      : null;
    const chunk: Chunk = {
      near: nearMesh,
      far: farMesh,
      halos: haloMesh,
      reflections,
      nearBase: (nearMesh.geometry.attributes.position.array as Float32Array).slice(),
      farBase: (farMesh.geometry.attributes.position.array as Float32Array).slice(),
      spans,
    };
    const old = this.chunks.get(key);
    if (old) this.dispose(old);
    this.chunks.set(key, chunk);
    this.group.add(nearMesh, farMesh);
    for (const b of list) {
      this.chunkOf.set(b.id, chunk);
      this.apply(b.id, this.state?.isDestroyed(b.id) ?? false);
    }
    this.field.refresh();
  }

  /**
   * Canopy lights of the gas stations still standing (intact: not abandoned / unfinished, not destroyed) and the flashing
   * beacons of the cranes of standing construction sites. Call after the chunk jobs.
   */
  buildLights(): void {
    const grid = this.grid;
    if (!grid) return;
    const defs: LightDef[] = [];
    const beacons: LightDef[] = [];
    for (const b of this.buildings) {
      const crane = b.crane;
      if (crane && b.condition === 'construction' && !this.state?.isDestroyed(b.id)) {
        const tx = crane.x + Math.sin(crane.heading) * crane.jib, tz = crane.z + Math.cos(crane.heading) * crane.jib;
        // Every crane flashes on its own beat (seeded by its building); the tip and the apex flash together.
        const phase = (hash32(b.seed, 0xbea) / 4294967296) * BEACON_PERIOD;
        for (const [x, y, z] of [[tx, crane.y + crane.height + CRANE_JIB_BEACON, tz], [crane.x, crane.y + crane.height + CRANE_APEX_BEACON, crane.z]]) {
          beacons.push({
            x, y, z, groundY: crane.y, radius: BEACON_RADIUS, color: BEACON_COLOR, intensity: BEACON_INTENSITY,
            anim: { kind: 'blink', period: BEACON_PERIOD, phase, duty: BEACON_DUTY },
          });
        }
      }
      if (b.condition !== 'intact' || this.state?.isDestroyed(b.id)) continue;
      const spec = buildingSpec(b.seed, b.type);
      for (const l of spec.lights) {
        const [x, y, z] = toWorld(b, [l.x, l.y, l.z]);
        defs.push({
          x, y, z, groundY: b.y, radius: l.radius, intensity: 1.6,
          color: new THREE.Color(l.color),
          dir: new THREE.Vector3(0, -1, 0), angle: THREE.MathUtils.degToRad(70),
        });
      }
    }
    this.lights.build(defs, grid);
    this.beacons.build(beacons, grid);
    this.lights.setHaloRange(this.lodDistance * 0.1, this.lodDistance * 0.4);
    this.lightsBuilt = true;
    this.level = -1;
  }

  /** Shows building `id` standing or as rubble. */
  private apply(id: number, destroyed: boolean): void {
    const chunk = this.chunkOf.get(id);
    const s = chunk?.spans.get(id);
    if (!chunk || !s) return;
    show(chunk.near, chunk.nearBase, s.near, !destroyed);
    show(chunk.near, chunk.nearBase, s.nearRubble, destroyed);
    show(chunk.far, chunk.farBase, s.far, !destroyed);
    show(chunk.far, chunk.farBase, s.farRubble, destroyed);
    showInstances(chunk.halos, s.halos, !destroyed);
    showInstances(chunk.reflections, s.reflections, !destroyed);
    const b = this.buildings[id];
    if (this.lightsBuilt && b && ((b.type === 'gas' && b.condition === 'intact') || b.crane)) this.buildLights();
  }

  /** Moves the detail switch distance of every chunk, built or future. */
  setLodDistance(distance: number): void {
    this.lodDistance = distance;
    for (const c of this.chunks.values()) {
      c.near.userData.lodMax = distance;
      c.far.userData.lodMin = distance;
    }
    this.setHaloRange();
  }

  private setHaloRange(): void {
    this.haloMaterial.uniforms.haloStart.value = this.lodDistance * 0.12;
    this.haloMaterial.uniforms.haloEnd.value = this.lodDistance * 0.5;
    this.lights.setHaloRange(this.lodDistance * 0.1, this.lodDistance * 0.4);
    this.beacons.setHaloRange(this.lodDistance * 0.1, this.lodDistance * 0.45);
  }

  /** Window, sign and canopy lights follow the daylight (0 night - 1 day). */
  update(daylight: number): void {
    const level = 1 - THREE.MathUtils.smoothstep(daylight, OFF_DAYLIGHT, ON_DAYLIGHT);
    if (level === this.level) return;
    this.level = level;
    for (const m of this.materials) m.uniforms.lampLevel.value = level;
    this.haloMaterial.uniforms.level.value = level;
    this.haloGroup.visible = level > 0.001;
    this.lights.level = level;
    this.beacons.level = BEACON_DAY_LEVEL + (1 - BEACON_DAY_LEVEL) * level;
    this.reflections.level = level;
  }

  private dispose(c: Chunk): void {
    for (const mesh of [c.near, c.far]) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    if (c.halos) {
      c.halos.geometry.dispose();
      c.halos.dispose();
      this.haloGroup.remove(c.halos);
    }
    if (c.reflections) this.reflections.remove(c.reflections);
  }

  clear(): void {
    for (const c of this.chunks.values()) this.dispose(c);
    this.chunks.clear();
    this.chunkOf.clear();
    this.buildings = [];
    this.lights.clear();
    this.beacons.clear();
    this.lightsBuilt = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.state = null;
  }
}

/** Restores a building's instances (visible) or zeroes their scale (hidden; the shaders skip them). */
function showInstances(mesh: THREE.InstancedMesh | null, { index, matrices }: Instances, visible: boolean): void {
  if (!mesh || !index.length) return;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  index.forEach((i, n) => mesh.setMatrixAt(i, visible ? matrices[n] : zero));
  mesh.instanceMatrix.needsUpdate = true;
}

/** Restores a vertex range (visible) or collapses it onto its first vertex (hidden: degenerate triangles). */
function show(mesh: THREE.Mesh, base: Float32Array, { start, count }: Span, visible: boolean): void {
  if (!count) return;
  const attr = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  const a = start * 3, b = (start + count) * 3;
  if (visible) arr.set(base.subarray(a, b), a);
  else for (let i = a; i < b; i += 3) arr.set(base.subarray(a, a + 3), i);
  attr.addUpdateRange(a, b - a);
  attr.needsUpdate = true;
}
