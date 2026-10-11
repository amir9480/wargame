// Particle system: GPU-simulated, instanced billboards.
//
// A particle is a pure function of the render clock and its slot (see shaders/particle.vert.glsl), so the CPU never updates
// particles: `build` writes two instance attributes per slot once, `update` only sets the clock. Cost per frame is the
// instances drawn, nothing else; thousands of emitters are fine because
//   - emitters are binned per effect and 64 m map chunk into one instanced mesh each, culled and LOD-switched by the Culler
//   - each effect has a near level (many small puffs) and a far level (few big puffs) that cross-fade in the shader, and
//     emitters beyond the far distance are not drawn at all
//   - `setDensity` (quality) thins every plume
//   - the fine puff pattern is only computed near the camera (surfaceDetail)
// Particles never cast shadows. They are blended into the HDR scene target without touching its alpha channel.

import * as THREE from 'three';
import type { ChunkGrid } from '../culling.ts';
import type { Environment } from '../world.ts';
import { EFFECTS, type EffectId, type ParticleEffect, type ParticleEmitter } from './effects.ts';
import vertexShader from '../shaders/particle.vert.glsl';
import fragmentShader from '../shaders/particle.frag.glsl';

/** Wind speed bound used for culling boxes (m/s); the actual wind is set with `setWind`. */
const MAX_WIND = 8;
/** Extra camera distance (m) the Culler tests on top of the shader cross-fade band: an emitter may be up to a chunk from its mesh's centre. */
const CHUNK_SLACK = 64;

interface Level {
  material: THREE.ShaderMaterial;
}

interface Range {
  attribute: THREE.InstancedBufferAttribute;
  start: number;
  count: number;
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  /** Shared by every material (the world updates fog / view uniforms on these). */
  readonly materials: THREE.ShaderMaterial[] = [];
  private readonly time = { value: 0 };
  private readonly density = { value: 1 };
  private readonly wind = { value: new THREE.Vector2(2.5, 1) };
  private readonly levels = new Map<EffectId, { near: Level; far: Level }>();
  private readonly quad: THREE.InstancedBufferGeometry;
  /** Per emitter (index in the `build` list): where its slots live, for `setIntensity`. */
  private ranges: Range[][] = [];
  private emitterCount = 0;

  private readonly env: Environment;

  constructor(env: Environment) {
    this.env = env;
    // One shared unit quad (-1..1); each mesh makes its own InstancedBufferGeometry that reuses these attributes.
    this.quad = new THREE.InstancedBufferGeometry();
    this.quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.quad.setIndex([0, 1, 2, 0, 2, 3]);
  }

  /** Number of emitters of the current map. */
  get emitters(): number {
    return this.emitterCount;
  }

  /** Quality: share of the particle slots that are drawn (0-1). */
  setDensity(density: number): void {
    this.density.value = density;
  }

  /** Wind blowing the plumes: direction in radians (world XZ plane, 0 = +X) and speed in m/s. */
  setWind(angle: number, speed: number): void {
    this.wind.value.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  /** Builds the instanced meshes of `emitters` (replacing the previous ones). Returns nothing: use the list index as the emitter's id. */
  build(emitters: ParticleEmitter[], grid: ChunkGrid): void {
    this.clear();
    this.emitterCount = emitters.length;
    this.ranges = emitters.map(() => []);

    // Bin by effect and chunk.
    const bins = new Map<string, { effect: EffectId; key: number; ids: number[] }>();
    emitters.forEach((e, id) => {
      const key = grid.key(e.x, e.z);
      const bin = bins.get(`${e.effect}:${key}`);
      if (bin) bin.ids.push(id);
      else bins.set(`${e.effect}:${key}`, { effect: e.effect, key, ids: [id] });
    });

    for (const { effect, key, ids } of bins.values()) {
      const def = EFFECTS[effect];
      const levels = this.levelsOf(effect);
      const center = grid.center(key);
      const box = new THREE.Box3();
      const reach = def.spread + def.sizeEnd * 2 + def.windDrift * MAX_WIND * def.life * 0.5;
      const top = def.rise * def.life + def.sizeEnd * 2;
      for (const id of ids) {
        const e = emitters[id];
        const s = e.scale ?? 1;
        box.expandByPoint(new THREE.Vector3(e.x - reach * s, e.y, e.z - reach * s));
        box.expandByPoint(new THREE.Vector3(e.x + reach * s, e.y + top * s, e.z + reach * s));
      }
      const band = def.nearDistance * 0.12;
      for (const far of [false, true]) {
        const count = far ? def.farCount : def.count;
        const n = ids.length * count;
        const origins = new Float32Array(n * 3);
        const data = new Float32Array(n * 4);
        let at = 0;
        for (const id of ids) {
          const e = emitters[id];
          // Emitters start at different phases (the seed) so neighbouring plumes don't pulse together.
          const seed = ((Math.imul(e.seed, 0x9e3779b1) >>> 0) % 1000) / 1000;
          const start = at;
          for (let k = 0; k < count; k++, at++) {
            origins.set([e.x, e.y, e.z], at * 3);
            data.set([seed, (k + 0.5) / count, e.scale ?? 1, e.intensity ?? 1], at * 4);
          }
          this.ranges[id].push({ attribute: null as unknown as THREE.InstancedBufferAttribute, start, count });
        }
        const geometry = new THREE.InstancedBufferGeometry();
        geometry.setAttribute('position', this.quad.getAttribute('position'));
        geometry.setIndex(this.quad.getIndex());
        geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
        const emit = new THREE.InstancedBufferAttribute(data, 4);
        emit.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('aEmit', emit);
        geometry.instanceCount = n;
        for (const id of ids) this.ranges[id][this.ranges[id].length - 1].attribute = emit;

        const mesh = new THREE.Mesh(geometry, (far ? levels.far : levels.near).material);
        mesh.userData.cullBox = box;
        mesh.userData.lodCenter = center;
        mesh.userData.lodBlend = band + CHUNK_SLACK;
        mesh.userData.noShadow = true;
        if (far) {
          mesh.userData.lodMin = def.nearDistance;
          mesh.userData.lodMax = def.farDistance;
        } else {
          mesh.userData.lodMax = def.nearDistance;
        }
        mesh.renderOrder = 10; // after the opaque map and the other transparent layers
        this.group.add(mesh);
      }
    }
  }

  /** Changes how many of an emitter's particles are emitted (0-1), e.g. a stopped factory or a burning ruin. `id` = index in the `build` list. */
  setIntensity(id: number, intensity: number): void {
    for (const { attribute, start, count } of this.ranges[id] ?? []) {
      const a = attribute.array as Float32Array;
      for (let k = 0; k < count; k++) a[(start + k) * 4 + 3] = intensity;
      attribute.needsUpdate = true;
    }
  }

  /** Render clock (seconds). */
  update(time: number): void {
    this.time.value = time;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      this.group.remove(child);
    }
    this.ranges = [];
    this.emitterCount = 0;
  }

  /** Materials of an effect (created on first use). */
  private levelsOf(effect: EffectId): { near: Level; far: Level } {
    let l = this.levels.get(effect);
    if (!l) {
      const def = EFFECTS[effect];
      l = { near: { material: this.makeMaterial(def, false) }, far: { material: this.makeMaterial(def, true) } };
      this.levels.set(effect, l);
      this.materials.push(l.near.material, l.far.material);
    }
    return l;
  }

  private makeMaterial(def: ParticleEffect, far: boolean): THREE.ShaderMaterial {
    const env = this.env;
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      defines: far ? { FAR: '' } : {},
      uniforms: {
        sunDir: { value: env.sunDir },
        sunColor: { value: env.sunColor },
        skyAmbient: { value: env.skyAmbient },
        groundAmbient: { value: env.groundAmbient },
        ...env.fog,
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
        time: this.time,
        density: this.density,
        wind: this.wind,
        life: { value: def.life },
        rise: { value: def.rise },
        riseDecay: { value: def.riseDecay },
        spread: { value: def.spread },
        windDrift: { value: def.windDrift },
        sizeStart: { value: def.sizeStart },
        sizeEnd: { value: def.sizeEnd },
        sizeMul: { value: far ? def.farSize : 1 },
        opacity: { value: def.opacity },
        fadeIn: { value: def.fadeIn },
        colorStart: { value: new THREE.Color(def.colorStart) },
        colorEnd: { value: new THREE.Color(def.colorEnd) },
        spin: { value: def.spin },
        lodNear: { value: def.nearDistance },
        lodBand: { value: def.nearDistance * 0.12 },
        lodFar: { value: def.farDistance },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Colour blends normally; the destination alpha is kept (the lighting pass reads alpha 0 as "sprite pixel").
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: this.mark ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
    });
  }

  /**
   * With the post pass the target's alpha records how much of the pixel the particles cover (post.frag.glsl fades shadows,
   * AO and local lights with it); without it the alpha must stay 1 (it would reach the canvas).
   */
  setCoverageMark(on: boolean): void {
    for (const m of this.materials) m.blendDstAlpha = on ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
    this.mark = on;
  }

  private mark = false;
}
