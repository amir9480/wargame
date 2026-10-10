// Town street furniture (plan: terrain/urban.ts): ground decals (paved yards round town buildings, gas station
// forecourts, car parks with driveways to their street), parked cars, and traffic lights at town intersections cycling
// green / yellow / red on a shared clock, plus tunnel portals (tunnels.ts). Sidewalks and junction plates are part of the
// road ribbons (roads.ts).

import * as THREE from 'three';
import { hash32, mulberry32 } from '../core/rng.ts';
import { sampleGrid, type ParkingLot, type RoadEdge, type Terrain } from '../terrain/generate.ts';
import { CURB_GAP, SIDEWALK_WIDTH, SIGNAL_GREEN, SIGNAL_YELLOW, planIntersections } from '../terrain/urban.ts';
import type { Environment, TerrainTextures } from './world.ts';
import type { LightDef, LightField, LightGroup } from './lights.ts';
import { groupByChunk, splitByChunk, type ChunkGrid } from './culling.ts';
import { MeshData } from './buildings/geometry.ts';
import { tunnelPortals } from './tunnels.ts';
import surfaceVertex from './shaders/building.vert.glsl';
import surfaceFragment from './shaders/building.frag.glsl';
import signalVertex from './shaders/trafficlight.vert.glsl';
import signalFragment from './shaders/trafficlight.frag.glsl';
import decalVertex from './shaders/decal.vert.glsl';
import decalFragment from './shaders/decal.frag.glsl';

const CAR_COLORS = [0xb8b8b8, 0x2b2d31, 0xe6e6e3, 0x7d1c1c, 0x1f3a66, 0x4b5a3a, 0x8a8f96, 0xc7a46a, 0x5a2f6b, 0xd05a1e];
/** Bay width and row depth (m), as planned by the buildings module. */
const BAY = 2.6;
const ROW = 5.3;
/** Tunnel portals are hidden beyond this camera distance (they are a few pixels there; the mountain reads anyway). */
const TUNNEL_DISTANCE = 900;

export class UrbanLayer {
  readonly group = new THREE.Group();
  readonly surfaceMaterial: THREE.ShaderMaterial;
  readonly signalMaterial: THREE.ShaderMaterial;
  readonly decalMaterial: THREE.ShaderMaterial;
  private signalModel: THREE.BufferGeometry;
  /** Traffic lights and parked cars are hidden beyond this camera distance. */
  private lodDistance = 350;
  /** One point light per signal pole, coloured by the showing lamp (night only, like the street lights). */
  private lights: LightGroup;
  private level = -1;

  constructor(textures: TerrainTextures, env: Environment, field: LightField) {
    this.lights = field.createGroup(true);
    const lighting = () => ({
      sunDir: { value: env.sunDir },
      sunColor: { value: env.sunColor },
      skyAmbient: { value: env.skyAmbient },
      groundAmbient: { value: env.groundAmbient },
      ...env.fog,
      fogNear: { value: 400 },
      fogFar: { value: 1200 },
    });
    this.surfaceMaterial = new THREE.ShaderMaterial({
      vertexShader: surfaceVertex,
      fragmentShader: surfaceFragment,
      vertexColors: true,
      uniforms: { ...lighting(), lampLevel: { value: 0 }, hour: env.hour },
    });
    this.signalMaterial = new THREE.ShaderMaterial({
      vertexShader: signalVertex,
      fragmentShader: signalFragment,
      vertexColors: true,
      uniforms: { ...lighting(), time: { value: 0 }, signalGreen: { value: SIGNAL_GREEN }, signalYellow: { value: SIGNAL_YELLOW } },
    });
    // Drawn after the road ribbons (render order), so driveways cross the sidewalks.
    this.decalMaterial = new THREE.ShaderMaterial({
      vertexShader: decalVertex,
      fragmentShader: decalFragment,
      transparent: true,
      depthWrite: false,
      uniforms: { ...lighting(), tDirt: { value: textures.dirt }, tAsphalt: { value: textures.asphalt } },
    });
    this.signalModel = trafficLightModel();
  }

  get materials(): THREE.ShaderMaterial[] {
    return [this.surfaceMaterial, this.signalMaterial, this.decalMaterial];
  }

  build(t: Terrain, grid: ChunkGrid): void {
    this.clear();

    // Ground decals: paved town yards, gas station forecourts, car parks (with driveways to their street).
    const decals = new DecalBuffers();
    for (const p of groundPatches(t)) decals.add(t, p.frame, p.u0, p.u1, p.v0, p.v1, p.kind, p.lot);
    const cars = new MeshData({ aWin: 2 });
    cars.cur.aWin = [0, 0];
    for (const lot of t.parking) parkCars(cars, lot, parkingGate(lot));
    if (decals.count) {
      const whole = decals.geometry();
      for (const part of splitByChunk(whole, grid)) {
        const mesh = new THREE.Mesh(part, this.decalMaterial);
        mesh.renderOrder = 0.95;
        mesh.userData.noShadow = true;
        this.group.add(mesh);
      }
      whole.dispose();
    }
    if (cars.vertexCount) {
      const whole = cars.toGeometry();
      for (const part of splitByChunk(whole, grid)) {
        const mesh = new THREE.Mesh(part, this.surfaceMaterial);
        mesh.userData.lodMax = this.lodDistance;
        this.group.add(mesh);
      }
      whole.dispose();
    }

    // Tunnel portals where roads / railways leave into a mountain range (outside towns too; few boxes each).
    const portals = tunnelPortals(t);
    if (portals.vertexCount) {
      const whole = portals.toGeometry();
      for (const part of splitByChunk(whole, grid)) {
        const mesh = new THREE.Mesh(part, this.surfaceMaterial);
        mesh.userData.lodMax = TUNNEL_DISTANCE;
        mesh.userData.fixedLod = true;
        this.group.add(mesh);
      }
      whole.dispose();
    }

    // Traffic lights, one InstancedMesh per chunk.
    const plan = planIntersections(t);
    const poles = plan.flatMap((x) => (x.signals ? x.approaches.filter((a) => a.pole).map((a) => ({ ...a.pole!, group: a.group, offset: x.offset })) : []));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const [key, list] of groupByChunk(poles, grid)) {
      const geo = this.signalModel.clone();
      const signal = new Float32Array(list.length * 2);
      const mesh = new THREE.InstancedMesh(geo, this.signalMaterial, list.length);
      list.forEach((p, i) => {
        mesh.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.yaw), one));
        signal.set([p.group, p.offset], i * 2);
      });
      geo.setAttribute('aSignal', new THREE.InstancedBufferAttribute(signal, 2));
      mesh.userData.lodMax = this.lodDistance;
      mesh.userData.lodCenter = grid.center(key);
      this.group.add(mesh);
    }

    // One light per pole, at the arm head's lamps (same frame as the model).
    const white = new THREE.Color(1, 1, 1);
    const lights: LightDef[] = poles.map((p) => {
      const at = HEAD_LIGHT.clone().applyAxisAngle(up, p.yaw);
      // Heads face the model's +Z: only traffic in front sees them (and their reflection).
      const facing = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
      return { x: p.x + at.x, y: p.y + at.y, z: p.z + at.z, groundY: p.y, radius: 5, color: white, intensity: 0.5, facing, signal: [p.group, p.offset] };
    });
    this.lights.build(lights, grid);
    this.lights.setHaloRange(this.lodDistance * 0.08, this.lodDistance * 0.35);
    this.level = -1;
  }

  setLodDistance(distance: number): void {
    this.lodDistance = distance;
    for (const child of this.group.children) if (child.userData.lodMax !== undefined && !child.userData.fixedLod) child.userData.lodMax = distance;
    this.lights.setHaloRange(distance * 0.08, distance * 0.35);
  }

  /** `time`: seconds on the signal clock (the same clock gameplay uses with signalAt). */
  update(time: number, daylight: number): void {
    this.signalMaterial.uniforms.time.value = time;
    // Glow switches on with the street lights.
    const level = 1 - THREE.MathUtils.smoothstep(daylight, 0.25, 0.65);
    if (level === this.level) return;
    this.level = level;
    this.lights.level = level;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      this.group.remove(child);
    }
    this.lights.clear();
  }
}

function groundAt(t: Terrain, x: number, z: number): number {
  const half = t.worldSize / 2;
  return sampleGrid(t.heights, t.size, (x + half) / t.cell, (z + half) / t.cell);
}

/** Footprint frame (building / car park): centre, ground height, yaw (local +Z = front, facing its street). */
export interface Frame {
  x: number;
  y: number;
  z: number;
  yaw: number;
  depth: number;
}

/**
 * Distance (m) from the middle of a footprint's front edge to the nearest road's carriageway edge, plus `overlap`
 * (so a driveway runs onto the road). 0 when no road is near.
 */
function toRoad(roads: RoadEdge[], f: Frame, overlap: number): number {
  const fx = f.x + Math.sin(f.yaw) * f.depth / 2, fz = f.z + Math.cos(f.yaw) * f.depth / 2;
  let best = Infinity;
  for (const e of roads) {
    const pts = e.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.abs(a.x - fx) > 30 || Math.abs(a.z - fz) > 30) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const k = Math.max(0, Math.min(1, ((fx - a.x) * dx + (fz - a.z) * dz) / len2));
      best = Math.min(best, Math.hypot(a.x + dx * k - fx, a.z + dz * k - fz) - e.width / 2);
    }
  }
  return Number.isFinite(best) && best < 20 ? Math.max(0, best) + overlap : 0;
}

/** Decal kinds (decal.frag.glsl). */
export const DECAL_PAVING = 1;
export const DECAL_ASPHALT = 2;
export const DECAL_PARKING = 3;
/** Paved margin (m) round town buildings (sides and back). */
const YARD = 1.5;

/** A ground decal: rectangle [u0, u1] x [v0, v1] in a footprint frame, its kind and car park data ([w, d, bays, gate]). */
export interface GroundPatch {
  frame: Frame;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  kind: number;
  lot: number[];
}

/** First of the two entrance bays of a car park's front row. */
function parkingGate(lot: ParkingLot): number {
  return Math.floor(lot.bays / 2) - 1;
}

/** Paved town yards, gas station forecourts and car parks, each reaching to its street (also the wet mask's, wetmask.ts). */
export function groundPatches(t: Pick<Terrain, 'roads' | 'buildings' | 'parking'>): GroundPatch[] {
  const roads = t.roads.edges.filter((e) => e.type !== 'rail');
  const out: GroundPatch[] = [];
  for (const b of t.buildings) {
    if (b.type === 'gas') {
      out.push({ frame: b, u0: -b.width / 2 - 1, u1: b.width / 2 + 1, v0: -b.depth / 2 - 1, v1: b.depth / 2 + toRoad(roads, b, 0.3), kind: DECAL_ASPHALT, lot: [0, 0, 0, 0] });
    } else if (b.city >= 0) {
      const front = Math.max(0.3, toRoad(roads, b, 0.3) - CURB_GAP - SIDEWALK_WIDTH);
      out.push({ frame: b, u0: -b.width / 2 - YARD, u1: b.width / 2 + YARD, v0: -b.depth / 2 - YARD, v1: b.depth / 2 + front, kind: DECAL_PAVING, lot: [0, 0, 0, 0] });
    }
  }
  for (const lot of t.parking) {
    const lotData = [lot.width, lot.depth, lot.bays, parkingGate(lot)];
    out.push({ frame: lot, u0: -lot.width / 2, u1: lot.width / 2, v0: -lot.depth / 2, v1: lot.depth / 2 + toRoad(roads, lot, 0.3), kind: DECAL_PARKING, lot: lotData });
  }
  return out;
}

/** Flat grids over footprints that follow the ground (vertex every ~2 m), drawn with decal.*.glsl. */
class DecalBuffers {
  private pos: number[] = [];
  private uv: number[] = [];
  private kind: number[] = [];
  private lot: number[] = [];
  private index: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  /** Rectangle [u0, u1] x [v0, v1] in the footprint frame `f`. */
  add(t: Terrain, f: Frame, u0: number, u1: number, v0: number, v1: number, kind: number, lot = [0, 0, 0, 0]): void {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    const nu = Math.max(1, Math.ceil((u1 - u0) / 2)), nv = Math.max(1, Math.ceil((v1 - v0) / 2));
    const base = this.count;
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const u = u0 + ((u1 - u0) * i) / nu, v = v0 + ((v1 - v0) * j) / nv;
        const x = f.x + u * c + v * s, z = f.z - u * s + v * c;
        this.pos.push(x, groundAt(t, x, z) + LIFT, z);
        this.uv.push(u, v);
        this.kind.push(kind);
        this.lot.push(...lot);
      }
    const at = (i: number, j: number) => base + j * (nu + 1) + i;
    // Facing up: (u, v) -> (u, v + 1) -> (u + 1, v).
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) this.index.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    g.setAttribute('aLot', new THREE.Float32BufferAttribute(this.lot, 4));
    g.setIndex(this.index);
    g.computeVertexNormals();
    return g;
  }
}
/** Decals sit this far over the ground (the road ribbons: 0.1). */
const LIFT = 0.06;

/** Parked cars, nose-in, in about 60% of the bays (seeded per car park); the entrance bays stay free. */
function parkCars(cars: MeshData, lot: ParkingLot, gate: number): void {
  const rng = mulberry32(hash32(lot.seed, 0xca75));
  const { width: w, depth: d, bays } = lot;
  cars.frame(lot.x, lot.y, lot.z, lot.yaw);
  const x0 = -w / 2 + 0.5;
  const rows = [[-d / 2 + 0.4, -d / 2 + 0.4 + ROW], [d / 2 - 0.4 - ROW, d / 2 - 0.4]];
  rows.forEach(([z0, z1], row) => {
    for (let k = 0; k < bays; k++) {
      if (row === 1 && (k === gate || k === gate + 1)) continue;
      if (rng() > 0.62) continue;
      const cx = x0 + (k + 0.5) * BAY + (rng() - 0.5) * 0.3;
      const cz = (z0 + z1) / 2 + (rng() - 0.5) * 0.4;
      const yaw = (rng() - 0.5) * 0.06;
      const color = CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)];
      cars.setColor(color);
      cars.box(cx, 0.22, cz, 1.75, 0.68, 4.2, yaw);
      cars.setColor(color, 0.75);
      cars.box(cx, 0.9, cz + (row ? 0.25 : -0.25), 1.55, 0.5, 2.2, yaw);
      cars.setColor(0x16181b);
      cars.box(cx, 0.0, cz, 1.85, 0.32, 3.4, yaw); // wheels / underbody
    }
  });
}

/** Light position of a pole (model frame): in front of the arm head's lamps. */
const HEAD_LIGHT = new THREE.Vector3(-2.4, 5.1, 0.6);

/** Pole with an arm over the road (model -X) carrying a signal head, plus a second head on the pole; heads face +Z. */
function trafficLightModel(): THREE.BufferGeometry {
  const m = new MeshData({ aLamp: 1 });
  m.frame(0, 0, 0, 0);
  m.cur.aLamp = [0];
  const steel = 0x50555b, housing = 0x1d1f22;
  m.setColor(steel);
  m.box(0, 0, 0, 0.18, 6.2, 0.18);
  m.box(-1.35, 5.85, 0, 2.7, 0.14, 0.14);
  const head = (x: number, y: number) => {
    m.cur.aLamp = [0];
    m.setColor(housing);
    m.box(x, y, 0.05, 0.36, 1.05, 0.28);
    [1, 2, 3].forEach((lamp, i) => {
      m.cur.aLamp = [lamp];
      m.setColor(0xffffff);
      m.box(x, y + 0.74 - i * 0.32, 0.2, 0.22, 0.22, 0.04);
    });
    m.cur.aLamp = [0];
  };
  head(-2.4, 4.75); // over the arriving lane
  head(0, 2.4);
  return m.toGeometry();
}
