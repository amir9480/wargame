// City models: the third level of detail of a town (after the near and far building meshes). Beyond a camera distance
// (`TownLod`) a town's detailed content is hidden and this layer draws the whole town as
//   - ONE merged mesh in the far-building shader: the buildings' far shapes WITH their window grid and lit windows (so a town
//     keeps its night look), the street surfaces (sidewalks + asphalt as flat strips draped on the road heights), paved yards
//     and car parks. No street lights, signals, cars or paint. It fades in with a dithered cross-fade (CITY_FADE in
//     buildingFar.frag.glsl, same blue noise as the trees' sprites) over the band round the switch distance.
//   - ONE instanced halo mesh: every street lamp and the buildings' window halos (shaders/cityhalo.vert.glsl). Instances too
//     near the camera collapse in the vertex shader (the real lamps and windows show there).
// So a town costs two draw calls at any distance beyond the switch, however big it is.
//
// Destruction: a building's body and rubble are vertex ranges of its town's mesh (like the chunk meshes of
// buildings/layer.ts), and its halo instances are scaled to nothing, so a destroyed building shows at every distance.

import * as THREE from 'three';
import { BuildingState, buildingSpec, sampleGrid, type City, type Terrain } from '../terrain/generate.ts';
import { CURB_GAP, SIDEWALK_WIDTH, townAt } from '../terrain/urban.ts';
import type { Environment } from './world.ts';
import type { LightField } from './lights.ts';
import { MeshData, buildFar, buildRubble, haloSpots, toWorld, windowSeed, type Span } from './buildings/geometry.ts';
import { CHUNK_HALF_DIAGONAL, show } from './buildings/layer.ts';
import { groundPatches, DECAL_ASPHALT, DECAL_PARKING } from './urban.ts';
import type { TownLod } from './townLod.ts';
import farVertex from './shaders/buildingFar.vert.glsl';
import farFragment from './shaders/buildingFar.frag.glsl';
import haloVertex from './shaders/cityhalo.vert.glsl';
import haloFragment from './shaders/lighthalo.frag.glsl';

/** Lamps and windows light up as the sky darkens (same curve as the street lights and window lights). */
const ON_DAYLIGHT = 0.65;
const OFF_DAYLIGHT = 0.25;
/** Window halo colour (linear) and disc size (m): as the buildings' own far halos. */
const WINDOW_HALO = new THREE.Color().setRGB(1.0, 0.62, 0.3, THREE.LinearSRGBColorSpace).multiplyScalar(0.55);
const WINDOW_HALO_SIZE = 0.9;

/** Surface colours and lifts (m over the road / ground height; higher layers cover lower ones, no depth fighting from far away). */
const SIDEWALK = 0x8e918d;
const ASPHALT = 0x393c41;
const DIRT = 0x7a6446;
const PAVING = 0x90948e;
const LIFT_PAVING = 0.25;
const LIFT_SIDEWALK = 0.3;
const LIFT_ROAD = 0.4;
/** Street strips are cut every this many metres (they follow the road's height). */
const STRIP_STEP = 16;

/** The far-building vertex streams (windows come from these, see buildFar); streets and yards leave them at 0 = plain colour. */
const FAR_ATTRIBUTES = { aFacade: 4, aGrid: 4, aCols: 4, aDoor: 4, aSeed: 1, aGlass: 3 };

interface Model {
  city: number;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Untouched positions, to restore collapsed ranges. */
  base: Float32Array;
  halos: THREE.InstancedMesh;
  matrices: THREE.Matrix4[];
}

interface BuildingEntry {
  model: Model;
  body: Span;
  rubble: Span;
  /** Indices of the building's instances in the halo mesh. */
  halos: number[];
}

export class CityLodLayer {
  readonly group = new THREE.Group();
  private readonly haloMaterial: THREE.ShaderMaterial;
  private readonly quad = new THREE.PlaneGeometry(1, 1);
  private readonly townLod: TownLod;
  private readonly noise: THREE.Texture;
  /** Uniforms every town's material shares (lighting, window schedule, lamp level). */
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly models: Model[] = [];
  /** Where each building of a town lives in its model (a change before the model exists is applied by `build`). */
  private readonly entries = new Map<number, BuildingEntry>();
  private level = -1;

  constructor(env: Environment, field: LightField, townLod: TownLod, noise: THREE.Texture) {
    this.townLod = townLod;
    this.noise = noise;
    this.shared = {
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
      farShrinkStart: { value: 300 + CHUNK_HALF_DIAGONAL },
    };
    this.haloMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      defines: { TOWN_FADE: '' }, // dithered cross-fade with the detailed halos
      uniforms: {
        level: { value: 0 },
        lampRange: { value: new THREE.Vector2(30, 150) },
        buildingRange: { value: new THREE.Vector2(600, 800) },
        hour: env.hour,
        time: field.uniforms.time,
        haloBokeh: field.uniforms.haloBokeh,
        townInfo: field.uniforms.townInfo,
        tNoise: field.uniforms.tNoise,
        fogOrigin: field.uniforms.fogOrigin,
        gameRight: field.uniforms.gameRight,
        gameUp: field.uniforms.gameUp,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
  }

  /** The towns' materials (the world updates fog uniforms on them every frame). */
  get materials(): THREE.ShaderMaterial[] {
    return this.models.map((m) => m.material);
  }

  /**
   * Quality: lamp halos fade in over 8% - 35% of the lamp draw distance (as the lamps' own discs did), the buildings' halos
   * just before the towns' switch distance; the far windows shrink from the building near / far switch on, as in the chunks.
   * Call after `TownLod.setDistance`.
   */
  setRanges(lampDistance: number, buildingDistance: number): void {
    const u = this.haloMaterial.uniforms;
    u.lampRange.value.set(lampDistance * 0.08, lampDistance * 0.35);
    u.buildingRange.value.set(0, 1); // the buildings' halos fade by the town cross-fade (townfade.glsl) instead
    this.shared.farShrinkStart.value = buildingDistance + CHUNK_HALF_DIAGONAL;
    for (const m of this.models) this.fadeUniforms(m);
  }

  private fadeUniforms({ city, material }: Model): void {
    material.uniforms.lodSwitch.value = this.townLod.switchAt(city);
    material.uniforms.lodBias.value = this.townLod.bias;
  }

  /**
   * One model per town. `lamps`: the street lamps standing in towns (StreetLightLayer.halos); `state`: destroyed buildings.
   */
  build(t: Terrain, lamps: { city: number; x: number; y: number; z: number; size: number; color: THREE.Color }[], state: BuildingState | null): void {
    this.clear();
    const patches = groundPatches(t);
    const half = t.worldSize / 2;
    const ground = (x: number, z: number) => sampleGrid(t.heights, t.size, (x + half) / t.cell, (z + half) / t.cell);
    for (const city of t.cities) {
      const buildings = t.buildings.filter((b) => b.city === city.id);
      if (!buildings.length) continue;
      const m = new MeshData(FAR_ATTRIBUTES);
      m.frame(0, 0, 0, 0);
      streets(m, t, city);
      yards(m, patches.filter((p) => townAt(t.cities, p.frame.x, p.frame.z) === city.id), ground);

      // Buildings: the far level's shapes and window grid, each with its rubble as a second vertex range.
      const spans = new Map<number, { body: Span; rubble: Span }>();
      for (const b of buildings) {
        const spec = buildingSpec(b.seed, b.type);
        const span = (fn: () => void): Span => {
          const start = m.vertexCount;
          fn();
          return { start, count: m.vertexCount - start };
        };
        spans.set(b.id, { body: span(() => buildFar(m, b, spec)), rubble: span(() => buildRubble(m, b, spec, true)) });
      }
      const material = this.makeMaterial(city);
      const mesh = new THREE.Mesh(m.toGeometry(), material);
      this.townLod.tag(mesh, city.id, 'model');
      this.group.add(mesh);

      // Halos: the town's lamps, then the buildings' window halos (the same spots, keys and schedule as the far level's).
      const lampList = lamps.filter((l) => l.city === city.id);
      const windows = buildings.flatMap((b) => {
        const spec = buildingSpec(b.seed, b.type);
        const seed = windowSeed(b);
        return haloSpots(b, spec).map((spot) => ({ b, pos: toWorld(b, spot.pos), key: [...spot.key, seed], share: spec.litShare }));
      });
      const count = lampList.length + windows.length;
      const geo = this.quad.clone();
      const key = new Float32Array(count * 4), share = new Float32Array(count).fill(-1);
      // Window halos belong to the town's city model (negative town); lamps have no detailed twin.
      const town = new Float32Array(count);
      const halos = new THREE.InstancedMesh(geo, this.haloMaterial, count);
      const mat = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      lampList.forEach((l, i) => {
        halos.setMatrixAt(i, mat.compose(new THREE.Vector3(l.x, l.y, l.z), q, new THREE.Vector3().setScalar(l.size)));
        halos.setColorAt(i, l.color);
      });
      const haloOf = new Map<number, number[]>();
      windows.forEach((w, n) => {
        const i = lampList.length + n;
        halos.setMatrixAt(i, mat.compose(new THREE.Vector3(...w.pos), q, new THREE.Vector3().setScalar(WINDOW_HALO_SIZE)));
        halos.setColorAt(i, WINDOW_HALO);
        key.set(w.key, i * 4);
        share[i] = w.share;
        town[i] = -(city.id + 1);
        const list = haloOf.get(w.b.id);
        if (list) list.push(i);
        else haloOf.set(w.b.id, [i]);
      });
      const matrices: THREE.Matrix4[] = [];
      for (let i = 0; i < count; i++) {
        const mtx = new THREE.Matrix4();
        halos.getMatrixAt(i, mtx);
        matrices.push(mtx);
      }
      geo.setAttribute('aHalo', new THREE.InstancedBufferAttribute(key, 4));
      geo.setAttribute('aHaloShare', new THREE.InstancedBufferAttribute(share, 1));
      geo.setAttribute('aTown', new THREE.InstancedBufferAttribute(town, 1));
      halos.userData.noShadow = true;
      halos.renderOrder = 2;
      // No distance limit of its own: the instances hide themselves in the shader while they are close.
      this.group.add(halos);

      const model: Model = { city: city.id, mesh, material, base: (mesh.geometry.attributes.position.array as Float32Array).slice(), halos, matrices };
      this.models.push(model);
      this.fadeUniforms(model);
      for (const b of buildings) this.entries.set(b.id, { model, ...spans.get(b.id)!, halos: haloOf.get(b.id) ?? [] });
    }
    for (const b of t.buildings) if (this.entries.has(b.id)) this.setDestroyed(b.id, state?.isDestroyed(b.id) ?? false);
    this.level = -1;
  }

  /** The far-building shader with this town's cross-fade (own uniforms: its centre and switch distance). */
  private makeMaterial(city: City): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: farVertex,
      fragmentShader: farFragment,
      vertexColors: true,
      defines: { CITY_FADE: '' },
      // Flat strips and yards sit a few decimetres over the ground: pull the whole model slightly towards the camera.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      uniforms: {
        ...this.shared,
        townCenter: { value: new THREE.Vector3(city.x, city.y, city.z) },
        tNoise: { value: this.noise },
        lodSwitch: { value: 0 },
        lodBias: { value: 1 },
      },
    });
  }

  /** Shows building `id` standing or as rubble in its town's model. */
  setDestroyed(id: number, destroyed: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    show(e.model.mesh, e.model.base, e.body, !destroyed);
    show(e.model.mesh, e.model.base, e.rubble, destroyed);
    if (e.halos.length) {
      const h = e.model.halos;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (const i of e.halos) h.setMatrixAt(i, destroyed ? zero : e.model.matrices[i]);
      h.instanceMatrix.needsUpdate = true;
    }
  }

  /** Lamps and windows follow the daylight (0 night - 1 day). */
  update(daylight: number): void {
    const level = 1 - THREE.MathUtils.smoothstep(daylight, OFF_DAYLIGHT, ON_DAYLIGHT);
    if (level === this.level) return;
    this.level = level;
    this.shared.lampLevel.value = level;
    this.haloMaterial.uniforms.level.value = level;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.InstancedMesh) {
        child.geometry.dispose();
        child.dispose();
      } else if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      this.group.remove(child);
    }
    this.models.length = 0;
    this.entries.clear();
  }
}

/** Flat strips for a town's streets: a wide sidewalk strip under a narrower road strip, cut every STRIP_STEP metres. */
function streets(m: MeshData, t: Terrain, city: City): void {
  for (const e of t.roads.edges) {
    if (e.type === 'rail') continue;
    const mid = e.points[Math.floor(e.points.length / 2)];
    if (townAt(t.cities, mid.x, mid.z) !== city.id) continue;
    const walk = e.type === 'asphalt' ? e.width + 2 * (CURB_GAP + SIDEWALK_WIDTH) : 0;
    // Points about STRIP_STEP apart (the ends always stay).
    const pts = [e.points[0]];
    let last = e.points[0];
    for (let i = 1; i < e.points.length; i++) {
      const p = e.points[i];
      if (i === e.points.length - 1 || Math.hypot(p.x - last.x, p.z - last.z) >= STRIP_STEP) {
        pts.push(p);
        last = p;
      }
    }
    const strip = (width: number, lift: number, color: number) => {
      m.setColor(color);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * (width / 2), nz = (dx / len) * (width / 2);
        m.face(
          [[a.x - nx, a.y + lift, a.z - nz], [a.x + nx, a.y + lift, a.z + nz], [b.x + nx, b.y + lift, b.z + nz], [b.x - nx, b.y + lift, b.z - nz]],
          [0, 1, 0],
        );
      }
    };
    if (walk) strip(walk, LIFT_SIDEWALK, SIDEWALK);
    strip(e.width, LIFT_ROAD, e.type === 'asphalt' ? ASPHALT : DIRT);
  }
}

/** Paved yards round the town's buildings, gas station forecourts and car parks: one quad each, corners on the ground. */
function yards(m: MeshData, patches: ReturnType<typeof groundPatches>, ground: (x: number, z: number) => number): void {
  for (const p of patches) {
    const f = p.frame;
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    const at = (u: number, v: number): [number, number, number] => {
      const x = f.x + u * c + v * s, z = f.z - u * s + v * c;
      return [x, ground(x, z) + LIFT_PAVING, z];
    };
    m.setColor(p.kind === DECAL_ASPHALT || p.kind === DECAL_PARKING ? ASPHALT : PAVING);
    m.face([at(p.u0, p.v0), at(p.u1, p.v0), at(p.u1, p.v1), at(p.u0, p.v1)], [0, 1, 0]);
  }
}
