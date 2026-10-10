import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, hash32, type Rng } from '../core/rng.ts';
import { planParkingLights, planStreetLights, streetIds, type LampKind } from '../terrain/streetlights.ts';
import type { Terrain } from '../terrain/generate.ts';
import type { Environment } from './world.ts';
import { groupByChunk, type ChunkGrid } from './culling.ts';
import type { LightDef, LightField, LightGroup } from './lights.ts';
import lampVertex from './shaders/streetlight.vert.glsl';
import lampFragment from './shaders/streetlight.frag.glsl';

/** Lamps switch on as the sky darkens: level goes 0 -> 1 between these daylight values (falling). */
const ON_DAYLIGHT = 0.65;
const OFF_DAYLIGHT = 0.25;

/** Lamp colours (linear RGB): sodium orange, cyan-white, green-white. Each street picks one and varies it a little. */
const LAMP_COLORS = [
  [1.0, 0.6, 0.24],
  [0.4, 0.88, 1.0],
  [0.52, 1.0, 0.45],
].map(([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace));

/** Seeded pick from LAMP_COLORS with a slight hue and brightness shift, so streets of a kind are similar but not identical. */
function pickLampColor(rng: Rng): THREE.Color {
  const c = LAMP_COLORS[Math.floor(rng() * LAMP_COLORS.length)].clone();
  const b = 0.88 + rng() * 0.24;
  return c.multiply(new THREE.Color().setRGB(b * (0.94 + rng() * 0.12), b * (0.94 + rng() * 0.12), b * (0.94 + rng() * 0.12), THREE.LinearSRGBColorSpace));
}

/** One lamp type: its model (pole along +Y, arm towards +Z) and the light it casts, in the model's frame. */
interface LampStyle {
  geometry: THREE.BufferGeometry;
  light: { pos: THREE.Vector3; intensity: number; radius: number; dir?: THREE.Vector3; angle?: number };
}

/** Street lights along the roads: instanced posts (one mesh per chunk and lamp type) plus a deferred light each. */
export class StreetLightLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  private styles: Record<LampKind, LampStyle>;
  private lights: LightGroup;
  private level = -1;
  /** Chunks whose centre is farther than this from the camera draw no lamp posts (their lights and discs stay). */
  private lodDistance = 350;

  constructor(env: Environment, field: LightField) {
    this.lights = field.createGroup();
    this.styles = { asphalt: asphaltLamp(), dirt: dirtLamp(), parking: parkingLamp() };
    this.material = new THREE.ShaderMaterial({
      vertexShader: lampVertex,
      fragmentShader: lampFragment,
      vertexColors: true,
      uniforms: {
        sunDir: { value: env.sunDir },
        sunColor: { value: env.sunColor },
        skyAmbient: { value: env.skyAmbient },
        groundAmbient: { value: env.groundAmbient },
        ...env.fog,
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
        lampLevel: { value: 0 },
        time: field.uniforms.time,
      },
    });
  }

  build(terrain: Terrain, grid: ChunkGrid): void {
    this.clear();
    // Colours are cosmetic but seeded, so a map always has the same lamps.
    // One colour per street (every lamp along it), streets in order of their id.
    const rng = mulberry32(hash32(terrain.seed, 0x1a3b));
    const street = streetIds(terrain.roads);
    const colors = new Map<number, THREE.Color>();
    for (const id of [...new Set(street)].sort((a, b) => a - b)) colors.set(id, pickLampColor(rng));
    // Car parks: one colour per lot, from its own hash (street colours stay as they were).
    const lotColor = (lot: number) => pickLampColor(mulberry32(hash32(terrain.seed, 0x9a4c00 + lot)));
    const spots = [
      ...planStreetLights(terrain).map((s) => ({ ...s, color: colors.get(street[s.edge])! })),
      ...planParkingLights(terrain).map((s) => ({ ...s, color: lotColor(s.lot) })),
    ];
    const lights: LightDef[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);

    for (const [key, chunk] of groupByChunk(spots, grid)) {
      const lodCenter = grid.center(key);
      for (const kind of ['asphalt', 'dirt', 'parking'] as const) {
        const posts = chunk.filter((s) => s.kind === kind);
        if (!posts.length) continue;
        const style = this.styles[kind];
        const mesh = new THREE.InstancedMesh(style.geometry, this.material, posts.length);
        posts.forEach((s, n) => {
          q.setFromAxisAngle(up, Math.atan2(s.dx, s.dz)); // model +Z -> towards the road
          m.compose(new THREE.Vector3(s.x, s.y, s.z), q, one);
          mesh.setMatrixAt(n, m);
          mesh.setColorAt(n, s.color); // tints the lamp's emissive parts
          const l = style.light;
          const pos = l.pos.clone().applyMatrix4(m);
          lights.push({
            x: pos.x, y: pos.y, z: pos.z, groundY: s.y,
            radius: l.radius, color: s.color, intensity: l.intensity,
            dir: l.dir?.clone().applyQuaternion(q), angle: l.angle,
          });
        });
        mesh.userData.lodMax = this.lodDistance;
        mesh.userData.lodCenter = lodCenter;
        this.group.add(mesh);
      }
    }
    this.lights.build(lights, grid);
    this.lights.setHaloRange(this.lodDistance * 0.08, this.lodDistance * 0.35);
    this.level = -1; // re-apply the dimmer to the new meshes
  }

  setLodDistance(distance: number): void {
    this.lodDistance = distance;
    for (const mesh of this.group.children) mesh.userData.lodMax = distance;
    this.lights.setHaloRange(distance * 0.08, distance * 0.35); // discs reach full strength well before the posts vanish
  }

  /** Switches the lamps on / off with the daylight (0 night - 1 day). */
  update(daylight: number): void {
    const level = 1 - THREE.MathUtils.smoothstep(daylight, OFF_DAYLIGHT, ON_DAYLIGHT);
    if (level === this.level) return;
    this.level = level;
    this.material.uniforms.lampLevel.value = level;
    this.lights.level = level;
  }

  clear(): void {
    // Lamp models are shared across builds; only the per-build instance buffers go.
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
      this.group.remove(child);
    }
    this.lights.clear();
  }
}

/** Collects box / cylinder parts into one vertex-coloured geometry (`color`, plus `glow` = 1 on emissive parts). */
class ModelBuilder {
  private parts: THREE.BufferGeometry[] = [];
  private frame = new THREE.Matrix4();
  private up = new THREE.Vector3(0, 1, 0);

  private add(g: THREE.BufferGeometry, hex: number, glow: number): void {
    g.deleteAttribute('uv');
    const color = new THREE.Color(hex);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    this.parts.push(g);
  }

  /** Vertical tapered pole from y0 to y1. */
  pole(rBottom: number, rTop: number, y0: number, y1: number, hex: number, sides = 8): this {
    const g = new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, sides);
    g.translate(0, (y0 + y1) / 2, 0);
    this.add(g, hex, 0);
    return this;
  }

  /** Square-section beam from a to b. */
  beam(a: THREE.Vector3, b: THREE.Vector3, thick: number, hex: number): this {
    const g = new THREE.BoxGeometry(thick, thick, a.distanceTo(b));
    g.applyMatrix4(this.frame.lookAt(a, b, this.up).setPosition(a.clone().add(b).multiplyScalar(0.5)));
    this.add(g, hex, 0);
    return this;
  }

  box(w: number, h: number, d: number, at: THREE.Vector3, hex: number, glow = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(at.x, at.y, at.z);
    this.add(g, hex, glow);
    return this;
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts);
    for (const g of this.parts) g.dispose();
    return merged;
  }
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Modern road lamp: tall tapered steel pole, curved arm, flat luminaire shining down on the carriageway. */
function asphaltLamp(): LampStyle {
  const steel = 0x6c7075, dark = 0x40444a;
  const geometry = new ModelBuilder()
    .pole(0.22, 0.2, 0, 0.5, dark)
    .pole(0.15, 0.09, 0.5, 8.7, steel)
    .beam(v(0, 8.3, 0), v(0, 9.15, 1.0), 0.13, steel)
    .beam(v(0, 9.15, 1.0), v(0, 9.1, 2.2), 0.12, steel)
    .box(0.5, 0.14, 1.1, v(0, 9.08, 2.35), dark)
    .box(0.4, 0.04, 0.9, v(0, 8.99, 2.35), 0xffd9a0, 1)
    .build();
  return {
    geometry,
    light: {
      pos: v(0, 8.95, 2.35), // just under the luminaire's glowing panel
      intensity: 2.0,
      radius: 21,
      dir: v(0, -1, -0.04).normalize(),
      angle: THREE.MathUtils.degToRad(64),
    },
  };
}

/** Car park lamp: shorter steel pole at the lot's back edge, straight arm, flat luminaire aimed a little into the lot. */
function parkingLamp(): LampStyle {
  const steel = 0x767a80, dark = 0x40444a;
  const geometry = new ModelBuilder()
    .pole(0.2, 0.2, 0, 0.45, dark)
    .pole(0.12, 0.08, 0.45, 7.3, steel)
    .beam(v(0, 7.0, 0), v(0, 7.25, 1.3), 0.1, steel)
    .box(0.45, 0.12, 0.9, v(0, 7.22, 1.7), dark)
    .box(0.36, 0.04, 0.72, v(0, 7.14, 1.7), 0xffe2b8, 1)
    .build();
  return {
    geometry,
    light: {
      pos: v(0, 7.1, 1.7),
      intensity: 1.9,
      radius: 19,
      dir: v(0, -1, 0.35).normalize(), // towards the middle of the lot
      angle: THREE.MathUtils.degToRad(66),
    },
  };
}

/** Country road lantern: wooden post with a bracket arm and a hanging lantern, point light. */
function dirtLamp(): LampStyle {
  const wood = 0x5a4129, iron = 0x2c2a28;
  const geometry = new ModelBuilder()
    .pole(0.13, 0.09, 0, 5.0, wood, 6)
    .beam(v(0, 4.75, 0), v(0, 4.95, 1.1), 0.09, wood)
    .beam(v(0, 3.95, 0), v(0, 4.85, 0.85), 0.07, wood)
    .box(0.03, 0.3, 0.03, v(0, 4.8, 1.1), iron)
    .box(0.4, 0.07, 0.4, v(0, 4.64, 1.1), iron)
    .box(0.28, 0.36, 0.28, v(0, 4.42, 1.1), 0xffc070, 1)
    .box(0.34, 0.05, 0.34, v(0, 4.21, 1.1), iron)
    .build();
  return {
    geometry,
    light: {
      pos: v(0, 4.4, 1.1),
      intensity: 1.7,
      radius: 11,
    },
  };
}
