// Power layer: power plants, substations, high-voltage pylon lines and roadside utility poles.
//
// Everything is world-space vertex-coloured meshes drawn with the building shaders, merged per map chunk and switched by camera
// distance like the other content (a detailed near mesh, a few-box far mesh):
//   sites   (plants, substations)  near < 450 m, far beyond (always drawn: a plant is a landmark, its stacks show from afar)
//   pylons  (towers + their wires)  near < 350 m, far up to 2000 m
//   poles   (utility poles + wires) near < 220 m, far up to 900 m
// Wires are thin sagging box chains. Cosmetic variety (wood / concrete poles, transformer counts) is seeded by the data.
//
// Lights go through the LightField (never ad-hoc lights): yard floodlights of the plants and substations (on from dusk to dawn,
// each with a far halo) and red aircraft beacons on the plant stacks (flashing, brighter at night).

import * as THREE from 'three';
import { hash32 } from '../core/rng.ts';
import {
  INSULATOR, POLE_SLOTS, PYLON_ARMS, PYLON_PEAK, pylonAttach, sampleGrid, siteGantry, siteScale, siteToWorld,
  type PowerSite, type Pylon, type Terrain, type UtilityPole,
} from '../terrain/generate.ts';
import type { Environment } from './world.ts';
import type { ChunkGrid } from './culling.ts';
import type { LightDef, LightField, LightGroup } from './lights.ts';
import { MeshData, WIN_NONE, WIN_SIGN } from './buildings/geometry.ts';
import { frustum, strut, type V3 } from './landmarks.ts';
import nearVertex from './shaders/building.vert.glsl';
import nearFragment from './shaders/building.frag.glsl';
import wireVertex from './shaders/wire.vert.glsl';
import wireFragment from './shaders/wire.frag.glsl';

/** Camera distance (m) where detailed meshes give way to the simple ones, and where the far ones disappear (0 = never). */
const LOD = {
  site: { near: 450, far: 0 },
  pylon: { near: 350, far: 2000 },
  pole: { near: 220, far: 900 },
} as const;
type Category = keyof typeof LOD;

/** Yard lamps are on from dusk to dawn (same curve as the street lights); the stack beacons keep a day level. */
const ON_DAYLIGHT = 0.65;
const OFF_DAYLIGHT = 0.25;
const BEACON_DAY_LEVEL = 0.5;

const LAMP_COLOR = new THREE.Color().setRGB(1.0, 0.82, 0.55, THREE.LinearSRGBColorSpace);
const LAMP_INTENSITY = 1.7;
const LAMP_RADIUS = 17;
const BEACON_COLOR = new THREE.Color().setRGB(1.0, 0.05, 0.03, THREE.LinearSRGBColorSpace);
const BEACON_INTENSITY = 4;
const BEACON_RADIUS = 14;

const STEEL = 0x8b9197;
const DARK_STEEL = 0x4b4f55;
const CONCRETE = 0xa8a59d;
const GRAVEL = 0x6f6d66;
const WIRE = 0x2d3034;
const INSULATOR_COLOR = 0xc9d3c6;
const PAINT_RED = 0xc0392b;
const PAINT_WHITE = 0xe6e3dc;
const TRANSFORMER = 0x6f7b72;
const WOOD = 0x5b4630;
const POLE_CONCRETE = 0x9c9a94;
const LAMP_HEAD = 0xffe2b0;

/** Sag of a span: sag = span^2 / SAG_K (m). */
const PYLON_SAG_K = 1700;
const POLE_SAG_K = 1400;

export class PowerLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  private readonly wireMaterial: THREE.ShaderMaterial;
  private lamps: LightGroup;
  private beacons: LightGroup;
  private level = -1;

  constructor(env: Environment, field: LightField) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: nearVertex,
      fragmentShader: nearFragment,
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
        hour: env.hour,
      },
    });
    // Shares the uniforms object, so the per-frame fog updates on `material` reach the wires too.
    this.wireMaterial = new THREE.ShaderMaterial({
      vertexShader: wireVertex,
      fragmentShader: wireFragment,
      vertexColors: true,
      uniforms: this.material.uniforms,
    });
    this.lamps = field.createGroup();
    this.beacons = field.createGroup(false, true);
    // Halos at full strength before the near meshes give way (see CLAUDE.md, light halos).
    this.lamps.setHaloRange(LOD.site.near * 0.08, LOD.site.near * 0.4);
    this.beacons.setHaloRange(LOD.site.near * 0.1, LOD.site.near * 0.45);
  }

  /** Builds the meshes and lights of the map's power network (replacing the previous ones). */
  build(terrain: Terrain, grid: ChunkGrid): void {
    this.clear(false);
    const { sites, lines, poles, links } = terrain.power;
    const half = terrain.worldSize / 2;
    const ground = (x: number, z: number) => sampleGrid(terrain.heights, terrain.size, (x + half) / terrain.cell, (z + half) / terrain.cell);

    // One near and one far buffer per category and chunk.
    const bins = new Map<string, { near: MeshData; far: MeshData; wnear: MeshData; wfar: MeshData; key: number; cat: Category }>();
    const bin = (cat: Category, x: number, z: number) => {
      const key = grid.key(x, z);
      const id = `${cat}:${key}`;
      let b = bins.get(id);
      if (!b) {
        const make = () => {
          const m = new MeshData({ aWin: 2, aKey: 4 });
          m.cur.aWin = [WIN_NONE, 0];
          return m;
        };
        const makeWire = () => new MeshData({ aThick: 1 });
        bins.set(id, (b = { near: make(), far: make(), wnear: makeWire(), wfar: makeWire(), key, cat }));
      }
      return b;
    };
    /** Like `draw`, into the chunk's wire meshes (own shader: wires fade out with distance instead of aliasing). */
    const drawWire = (cat: Category, x: number, z: number, fn: (m: MeshData, far: boolean) => void) => {
      const b = bin(cat, x, z);
      fn(b.wnear, false);
      fn(b.wfar, true);
    };
    /** Draws into both levels of detail of the category's chunk at (x, z). */
    const draw = (cat: Category, x: number, z: number, fn: (m: MeshData, far: boolean) => void) => {
      const b = bin(cat, x, z);
      fn(b.near, false);
      fn(b.far, true);
    };

    const lampDefs: LightDef[] = [], beaconDefs: LightDef[] = [];

    for (const s of sites) {
      draw('site', s.x, s.z, (m, far) => (s.kind === 'plant' ? buildPlant(m, s, far) : buildSubstation(m, s, far)));
      for (const [lx, ly, lz] of siteLamps(s)) {
        const [x, y, z] = siteToWorld(s, lx, ly, lz);
        lampDefs.push({ x, y, z, radius: LAMP_RADIUS, color: LAMP_COLOR, intensity: LAMP_INTENSITY, groundY: s.y });
      }
      if (s.kind === 'plant') {
        for (const st of plantStacks(s)) {
          for (const f of [1, 0.55]) {
            const [x, y, z] = siteToWorld(s, st.x, st.height * f + 0.6, st.z);
            beaconDefs.push({
              x, y, z, radius: BEACON_RADIUS, color: BEACON_COLOR, intensity: BEACON_INTENSITY, groundY: s.y,
              anim: { kind: 'blink', period: 1.8 + (s.seed % 7) * 0.05, phase: (s.seed % 13) * 0.1, duty: 0.25 },
            });
          }
        }
      }
    }

    for (const line of lines) {
      const ps = line.pylons;
      if (!ps.length) {
        // Neighbouring sites (no room for a pylon between them): the gantries are wired straight across.
        const [a, b] = [sites[line.a], sites[line.b]];
        const ga = siteGantry(a).map((g) => siteToWorld(a, g.x, g.y, g.z)), gb = siteGantry(b).map((g) => siteToWorld(b, g.x, g.y, g.z));
        const swap = Math.hypot(ga[0][0] - gb[0][0], ga[0][2] - gb[0][2]) + Math.hypot(ga[1][0] - gb[1][0], ga[1][2] - gb[1][2])
          > Math.hypot(ga[0][0] - gb[1][0], ga[0][2] - gb[1][2]) + Math.hypot(ga[1][0] - gb[0][0], ga[1][2] - gb[0][2]);
        drawWire('pylon', (a.x + b.x) / 2, (a.z + b.z) / 2, (m, far) => {
          m.frame(0, 0, 0, 0);
          m.setColor(WIRE, 0.9);
          for (let n = 0; n < 2; n++) wire(m, ga[n], gb[swap ? 1 - n : n], PYLON_SAG_K, 0.08, far);
        });
        continue;
      }
      for (const p of ps) draw('pylon', p.x, p.z, (m, far) => buildPylon(m, p, ground, far));
      for (let n = 1; n < ps.length; n++) {
        const a = pylonAttach(ps[n - 1]), b = pylonAttach(ps[n]);
        const mx = (ps[n - 1].x + ps[n].x) / 2, mz = (ps[n - 1].z + ps[n].z) / 2;
        drawWire('pylon', mx, mz, (m, far) => {
          m.frame(0, 0, 0, 0);
          m.setColor(WIRE, 0.9);
          a.forEach((p, s) => wire(m, p, b[s], PYLON_SAG_K, s === 6 ? 0.05 : 0.08, far));
        });
        // Aerial marker balls on the top (earth) wire, alternating orange and white.
        draw('pylon', mx, mz, (m, far) => markerBalls(m, a[6], b[6], PYLON_SAG_K, far));
      }
      // The end pylons' conductors run to the sites' gantries.
      for (const [pylon, site] of [[ps[0], sites[line.a]], [ps[ps.length - 1], sites[line.b]]] as const) {
        if (!pylon || !site) continue;
        const gantry = siteGantry(site).map((g) => siteToWorld(site, g.x, g.y, g.z));
        drawWire('pylon', pylon.x, pylon.z, (m, far) => {
          m.frame(0, 0, 0, 0);
          m.setColor(WIRE, 0.9);
          pylonAttach(pylon).slice(0, 6).forEach((p) => {
            const g = gantry[Math.hypot(p[0] - gantry[0][0], p[2] - gantry[0][2]) <= Math.hypot(p[0] - gantry[1][0], p[2] - gantry[1][2]) ? 0 : 1];
            wire(m, p, g, PYLON_SAG_K * 2, 0.07, far);
          });
        });
      }
    }

    for (const p of poles) draw('pole', p.x, p.z, (m, far) => buildPole(m, p, far));
    for (const [a, b] of links) {
      const pa = poles[a], pb = poles[b];
      drawWire('pole', (pa.x + pb.x) / 2, (pa.z + pb.z) / 2, (m, far) => {
        m.frame(0, 0, 0, 0);
        m.setColor(WIRE, 0.9);
        for (let u = 0; u < 3; u++) wire(m, poleAttach(pa, pb.x - pa.x, pb.z - pa.z, u), poleAttach(pb, pb.x - pa.x, pb.z - pa.z, u), POLE_SAG_K, 0.045, far);
      });
    }
    // Each source site's feed: the gantry's two points and their middle to the first pole's three conductors.
    for (const s of sites) {
      const pole = poles[s.feeder];
      if (!pole) continue;
      const g = siteGantry(s).map((p) => siteToWorld(s, p.x, p.y, p.z));
      const mid: V3 = [(g[0][0] + g[1][0]) / 2, (g[0][1] + g[1][1]) / 2, (g[0][2] + g[1][2]) / 2];
      drawWire('pole', pole.x, pole.z, (m, far) => {
        m.frame(0, 0, 0, 0);
        m.setColor(WIRE, 0.9);
        const dx = g[0][0] - pole.x, dz = g[0][2] - pole.z;
        const ends = [poleAttach(pole, dx, dz, 0), poleAttach(pole, dx, dz, 1), poleAttach(pole, dx, dz, 2)];
        // Pair the gantry's points with the arm's outer conductors by distance.
        const d = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
        const straight = d(g[0], ends[0]) + d(g[1], ends[2]) <= d(g[0], ends[2]) + d(g[1], ends[0]);
        wire(m, straight ? g[0] : g[1], ends[0], POLE_SAG_K, 0.045, far);
        wire(m, mid, ends[1], POLE_SAG_K, 0.045, far);
        wire(m, straight ? g[1] : g[0], ends[2], POLE_SAG_K, 0.045, far);
      });
    }

    for (const b of bins.values()) {
      const lod = LOD[b.cat];
      const center = grid.center(b.key);
      for (const [far, wires] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        const m = wires ? (far ? b.wfar : b.wnear) : far ? b.far : b.near;
        if (!m.vertexCount) continue;
        const mesh = new THREE.Mesh(m.toGeometry(), wires ? this.wireMaterial : this.material);
        mesh.userData.lodCenter = center;
        if (far) {
          mesh.userData.lodMin = lod.near;
          if (lod.far) mesh.userData.lodMax = lod.far;
        } else {
          mesh.userData.lodMax = lod.near;
        }
        this.group.add(mesh);
      }
    }
    this.lamps.build(lampDefs, grid);
    this.beacons.build(beaconDefs, grid);
    this.level = -1;
  }

  /** Lamp levels follow the daylight (0 night - 1 day): yard floodlights on at night, stack beacons dimmer by day. */
  update(daylight: number): void {
    const night = 1 - THREE.MathUtils.smoothstep(daylight, OFF_DAYLIGHT, ON_DAYLIGHT);
    if (night === this.level) return;
    this.level = night;
    this.material.uniforms.lampLevel.value = night;
    this.lamps.level = night;
    this.beacons.level = BEACON_DAY_LEVEL + (1 - BEACON_DAY_LEVEL) * night;
  }

  /** Drops every mesh (and, unless `lights` is false, the lights) of the current map. */
  clear(lights = true): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      this.group.remove(child);
    }
    if (lights) {
      this.lamps.clear();
      this.beacons.clear();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Wires

/** Sagging wire from a to b as a chain of thin boxes (parabola, lowest in the middle). */
function wire(m: MeshData, a: V3, b: V3, sagK: number, thick: number, far: boolean): void {
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const sag = (len * len) / sagK;
  const segs = far ? 3 : Math.max(3, Math.min(10, Math.round(len / 10)));
  const t = far ? thick * 2.2 : thick;
  m.cur.aThick = [thick]; // the real thickness: the far meshes are inflated for looks, the fade must not follow
  let prev = a;
  for (let s = 1; s <= segs; s++) {
    const f = s / segs;
    const next: V3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f - 4 * sag * f * (1 - f), a[2] + (b[2] - a[2]) * f];
    strut(m, prev, next, t);
    prev = next;
  }
}

const MARKER_ORANGE = 0xe8590c;
const MARKER_WHITE = 0xf2efe8;
const MARKER_SPACING = 36;
const MARKER_RADIUS = 0.6;

/** Aviation marker balls strung along the wire a -> b (same parabola as `wire`), clear of the pylons at both ends. */
function markerBalls(m: MeshData, a: V3, b: V3, sagK: number, far: boolean): void {
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const count = Math.floor((len - 30) / MARKER_SPACING) + 1;
  if (count < 1) return;
  const sag = (len * len) / sagK;
  m.frame(0, 0, 0, 0);
  const lat = far ? 3 : 6, lon = far ? 5 : 10, r = far ? MARKER_RADIUS * 1.5 : MARKER_RADIUS;
  for (let k = 0; k < count; k++) {
    const f = 0.5 + (k - (count - 1) / 2) * (MARKER_SPACING / len);
    const c: V3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f - 4 * sag * f * (1 - f), a[2] + (b[2] - a[2]) * f];
    m.setColor(k % 2 ? MARKER_WHITE : MARKER_ORANGE);
    const ring = (i: number, j: number): V3 => {
      const th = (i / lat) * Math.PI, ph = (j / lon) * Math.PI * 2;
      return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    };
    for (let i = 0; i < lat; i++) {
      for (let j = 0; j < lon; j++) {
        const q = [ring(i, j), ring(i, j + 1), ring(i + 1, j + 1), ring(i + 1, j)];
        const n: V3 = [0, 0, 0];
        for (const p of q) { n[0] += p[0]; n[1] += p[1]; n[2] += p[2]; }
        const nl = Math.hypot(...n) || 1;
        m.face(q.map((p): V3 => [c[0] + p[0] * r, c[1] + p[1] * r, c[2] + p[2] * r]), [n[0] / nl, n[1] / nl, n[2] / nl]);
      }
    }
  }
}

/** Tapered upright prism centred on (cx, cz): radius r0 at y0 to r1 at y0 + h (no caps). */
function frustumAt(m: MeshData, cx: number, cz: number, y0: number, r0: number, r1: number, h: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, mid = (a0 + a1) / 2;
    m.face(
      [[cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0], [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0],
        [cx + Math.cos(a1) * r1, y0 + h, cz + Math.sin(a1) * r1], [cx + Math.cos(a0) * r1, y0 + h, cz + Math.sin(a0) * r1]],
      [Math.cos(mid), 0, Math.sin(mid)],
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pylons

/** Half width of a pylon's body at height y (wide base, narrow waist, slim top). */
function pylonHalf(y: number, H: number): number {
  const f = y / H;
  return f < 0.45 ? 3.3 + (1.0 - 3.3) * (f / 0.45) : 1.0 + (0.75 - 1.0) * ((f - 0.45) / 0.55);
}

function buildPylon(m: MeshData, p: Pylon, ground: (x: number, z: number) => number, far: boolean): void {
  m.frame(p.x, p.y, p.z, p.yaw);
  const H = p.height;
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const fractions = far ? [0, 0.45, 1] : [0, 0.14, 0.28, 0.45, 0.62, 0.78, 0.92, 1];
  const ys = fractions.map((f) => f * H);
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const at = (y: number, sx: number, sz: number): V3 => [sx * pylonHalf(y, H), y, sz * pylonHalf(y, H)];

  m.setColor(STEEL);
  // Legs: each starts on the ground under its own foot (slopes), then climbs level by level.
  for (const [sx, sz] of corners) {
    const lx = sx * pylonHalf(0, H), lz = sz * pylonHalf(0, H);
    const footY = ground(p.x + lx * c + lz * s, p.z - lx * s + lz * c) - p.y - 0.5;
    strut(m, [lx, footY, lz], at(ys[1], sx, sz), far ? 0.6 : 0.34);
    for (let i = 1; i < ys.length - 1; i++) strut(m, at(ys[i], sx, sz), at(ys[i + 1], sx, sz), far ? 0.5 : i < 4 ? 0.3 : 0.22);
  }
  if (!far) {
    // Ring braces at every level, X braces between levels on the four faces.
    for (let i = 0; i < ys.length; i++) {
      for (let k = 0; k < 4; k++) {
        const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4];
        strut(m, at(ys[i], ax, az), at(ys[i], bx, bz), 0.15);
        if (i < ys.length - 1) {
          strut(m, at(ys[i], ax, az), at(ys[i + 1], bx, bz), 0.1);
          strut(m, at(ys[i], bx, bz), at(ys[i + 1], ax, az), 0.1);
        }
      }
    }
  }
  // Cross-arms with insulator strings, and the earth wire peak.
  for (const arm of PYLON_ARMS) {
    const y = H * arm.at;
    m.setColor(STEEL);
    if (far) {
      m.box(0, y - 0.25, 0, arm.half * 2, 0.5, 0.7);
    } else {
      strut(m, [-arm.half, y, 0], [arm.half, y, 0], 0.32);
      for (const side of [-1, 1]) {
        strut(m, [side * arm.half, y, 0], [side * 0.5, y + 2.4, 0], 0.16);
        strut(m, [side * arm.half, y, 0], [side * 0.6, y - 1.6, 0], 0.14);
      }
    }
    m.setColor(INSULATOR_COLOR, 0.9);
    for (const side of [-1, 1]) m.box(side * arm.half, y - INSULATOR, 0, far ? 0.4 : 0.24, INSULATOR, far ? 0.4 : 0.24);
  }
  m.setColor(STEEL);
  strut(m, [0, H, 0], [0, H + PYLON_PEAK, 0], far ? 0.4 : 0.26);
}

// ---------------------------------------------------------------------------------------------------------------------
// Utility poles

/** World position of conductor `u` (0..2) on a pole for a wire heading along (dx, dz): the slots flip with the pole's facing. */
function poleAttach(p: UtilityPole, dx: number, dz: number, u: number): V3 {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  // Local +X in world is (c, -s); "left of the wire" is (dz, -dx), so the slot sits on the side that matches for every pole.
  const side = c * dz + s * dx >= 0 ? 1 : -1;
  const slot = POLE_SLOTS[u];
  const lx = slot.x * side;
  return [p.x + lx * c, p.y + p.height + slot.dy, p.z - lx * s];
}

function buildPole(m: MeshData, p: UtilityPole, far: boolean): void {
  m.frame(p.x, p.y, p.z, p.yaw);
  const h = p.height;
  const concrete = hash32(p.seed, 3) % 10 < 3;
  m.setColor(concrete ? POLE_CONCRETE : WOOD);
  if (far) {
    m.box(0, -0.2, 0, 0.3, h + 0.2, 0.3);
    m.setColor(WOOD, 0.8);
    m.box(0, h - 0.6, 0, 2.2, 0.16, 0.16);
    return;
  }
  frustum(m, -0.3, 0.17, 0.11, h + 0.3, 6);
  // Cross-arm with two braces, three insulators (the middle one on the pole top).
  m.setColor(WOOD, 0.8);
  m.box(0, h - 0.6, 0, 2.2, 0.12, 0.14);
  strut(m, [0, h - 1.5, 0], [0.9, h - 0.62, 0], 0.07);
  strut(m, [0, h - 1.5, 0], [-0.9, h - 0.62, 0], 0.07);
  m.setColor(INSULATOR_COLOR, 0.85);
  for (const slot of POLE_SLOTS) m.box(slot.x, h + slot.dy - 0.32, 0, 0.1, 0.32, 0.1);
  if (p.transformer) {
    m.setColor(TRANSFORMER);
    m.cylinder(0, h - 2.6, 0.42, 0.55, 0.95, 8);
    m.setColor(DARK_STEEL);
    m.box(0, h - 2.65, 0.42, 0.7, 0.05, 0.1);
    m.setColor(INSULATOR_COLOR, 0.85);
    for (const x of [-0.18, 0, 0.18]) m.box(x, h - 1.65, 0.42, 0.05, 0.4, 0.05);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared site pieces (local frame: origin at the pad centre, +Z = front)

/** Perimeter fence with a gate gap in the middle of the front side. */
function fence(m: MeshData, w: number, d: number, far: boolean): void {
  if (far) return;
  m.setColor(DARK_STEEL, 0.9);
  const hw = w / 2, hd = d / 2, gate = 3;
  const run = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 3));
    for (let i = 0; i <= n; i++) m.box(x0 + ((x1 - x0) * i) / n, 0, z0 + ((z1 - z0) * i) / n, 0.1, 2.3, 0.1);
    for (const y of [0.7, 2.2]) strut(m, [x0, y, z0], [x1, y, z1], 0.05);
  };
  run(-hw, -hd, hw, -hd);
  run(-hw, -hd, -hw, hd);
  run(hw, -hd, hw, hd);
  run(-hw, hd, -gate, hd);
  run(gate, hd, hw, hd);
}

/** Transformer: tank with radiator fins, three bushings, a conservator tank. */
function transformer(m: MeshData, x: number, z: number, far: boolean, scale = 1): void {
  m.setColor(TRANSFORMER);
  m.box(x, 0, z, 4.6 * scale, 3.3 * scale, 3.2 * scale);
  m.setColor(DARK_STEEL, 0.9);
  if (!far) {
    for (let i = 0; i < 4; i++) m.box(x + 2.5 * scale, 0.3, z - 1.1 * scale + i * 0.75 * scale, 0.4, 2.6 * scale, 0.25);
    m.setColor(TRANSFORMER, 0.9);
    m.cylinder(x, 3.3 * scale, z - 1.8 * scale, 1.0 * scale, 1.0 * scale, 8); // conservator
    m.setColor(INSULATOR_COLOR, 0.85);
    for (const dx of [-1.2, 0, 1.2]) m.box(x + dx * scale, 3.3 * scale, z + 0.2, 0.22, 1.4 * scale, 0.22);
  }
}

/** Gantry: two posts and a beam at the site's gantry points, with insulator strings (where the pylon line ends). */
function gantry(m: MeshData, site: PowerSite, far: boolean): void {
  const [a, b] = siteGantry(site);
  m.setColor(STEEL);
  for (const g of [a, b]) {
    m.box(g.x, 0, g.z, far ? 0.8 : 0.55, g.y + 0.6, far ? 0.8 : 0.55);
    if (far) continue;
    strut(m, [g.x - 0.9, 0, g.z], [g.x, g.y * 0.6, g.z], 0.14);
    strut(m, [g.x + 0.9, 0, g.z], [g.x, g.y * 0.6, g.z], 0.14);
  }
  m.box((a.x + b.x) / 2, a.y + 0.2, a.z, b.x - a.x + 0.8, 0.5, 0.5);
  m.setColor(INSULATOR_COLOR, 0.9);
  for (const g of [a, b]) m.box(g.x, g.y - 0.9, g.z, 0.2, 1.1, 0.2);
}

/** Lamp posts of a site (local x, top y, local z) with floodlight heads that glow at night. */
export function siteLamps(site: PowerSite): [number, number, number][] {
  const k = siteScale(site);
  const hw = site.width / 2 - 1.2 * k, hd = site.depth / 2 - 1.2 * k;
  const y = site.kind === 'plant' ? 7.5 : 6.5;
  return [[-hw, y, -hd], [hw, y, -hd], [-hw, y, hd], [hw, y, hd]];
}

function lampPosts(m: MeshData, site: PowerSite, far: boolean): void {
  for (const [x, y, z] of siteLamps(site)) {
    m.setColor(DARK_STEEL);
    m.box(x, 0, z, 0.22, y, 0.22);
    if (far) continue;
    m.cur.aWin = [WIN_SIGN, 1];
    m.setColor(LAMP_HEAD);
    m.box(x, y, z, 0.7, 0.18, 0.5);
    m.cur.aWin = [WIN_NONE, 0];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Substation

function buildSubstation(m: MeshData, s: PowerSite, far: boolean): void {
  m.frame(s.x, s.y, s.z, s.yaw);
  const k = siteScale(s);
  const W = s.width, D = s.depth;
  m.setColor(GRAVEL);
  m.box(0, -0.3, 0, W, 0.4, D);
  fence(m, W, D, far);
  // Two or three transformers in a row at the back, bushings on top.
  const count = 2 + (hash32(s.seed, 4) % 2);
  for (let i = 0; i < count; i++) transformer(m, (i - (count - 1) / 2) * 6.4 * k, -D * 0.22, far, Math.max(0.7, k));
  gantry(m, s, far);
  // Control hut by the gate.
  m.setColor(CONCRETE);
  m.box(W * 0.28, 0, D * 0.2, 5 * k + 1, 3.2, 3.4 * k + 0.6);
  m.setColor(0x6e6a64);
  m.box(W * 0.28, 3.2, D * 0.2, 5.4 * k + 1, 0.25, 3.8 * k + 0.6);
  if (!far) {
    m.setColor(DARK_STEEL);
    m.box(W * 0.28, 0, D * 0.2 + (3.4 * k + 0.6) / 2 + 0.02, 1.1, 2.1, 0.08);
  }
  lampPosts(m, s, far);
}

// ---------------------------------------------------------------------------------------------------------------------
// Power plant

/** Chimney stacks of a plant (local x, z, height), after scaling. */
export function plantStacks(s: PowerSite): { x: number; z: number; height: number }[] {
  const k = siteScale(s), hs = 0.6 + 0.4 * k;
  const xs = s.stacks === 1 ? [-12] : [-18, -6];
  return xs.map((x, i) => ({ x: x * k, z: -22 * k, height: (74 + 10 * ((hash32(s.seed, 7 + i) % 100) / 100)) * hs }));
}

/** Cooling tower / condenser spots (local x, z, base radius) at site scale k. */
function coolerSpots(k: number): [number, number, number][] {
  return [[19 * k, -10 * k, 10.5 * k], [19 * k, 13 * k, 8.5 * k]];
}

/** Open tops of a plant's hyperbolic cooling towers (local x, z, height, radius), after scaling: where the steam comes out. */
export function plantCoolers(s: PowerSite): { x: number; z: number; height: number; radius: number }[] {
  if (s.coolers === 0) return [];
  const k = siteScale(s), hs = 0.6 + 0.4 * k;
  return coolerSpots(k).slice(0, Math.min(2, s.coolers)).map(([x, z, R]) => ({ x, z, height: 48 * hs, radius: R * 0.78 }));
}

function buildPlant(m: MeshData, s: PowerSite, far: boolean): void {
  m.frame(s.x, s.y, s.z, s.yaw);
  const k = siteScale(s);
  const hs = 0.6 + 0.4 * k; // building heights shrink less than their footprints
  const W = s.width, D = s.depth;
  m.setColor(GRAVEL);
  m.box(0, -0.3, 0, W, 0.4, D);
  fence(m, W, D, far);

  // Turbine hall: long low block with a darker glazing band and a flat roof with a ridge light.
  const hall = { x: -12 * k, z: -1 * k, w: 34 * k, d: 16 * k, h: 15 * hs };
  m.setColor(0xa9b0b5);
  m.box(hall.x, 0, hall.z, hall.w, hall.h, hall.d);
  m.setColor(0x6b7075);
  m.box(hall.x, hall.h, hall.z, hall.w + 0.5, 0.4, hall.d + 0.5);
  if (!far) {
    m.setColor(0x3d4a55, 0.9);
    m.box(hall.x, hall.h * 0.62, hall.z, hall.w + 0.12, 2.6, hall.d + 0.12);
    m.setColor(0x8a9096);
    m.box(hall.x, hall.h + 0.4, hall.z, hall.w * 0.7, 1.2, 3 * k + 1);
  }
  // Boiler house: taller, warmer, with a pipe bridge to the hall.
  const boiler = { x: -12 * k, z: -14 * k, w: 22 * k, d: 12 * k, h: 27 * hs };
  m.setColor(0xb5aca0);
  m.box(boiler.x, 0, boiler.z, boiler.w, boiler.h, boiler.d);
  m.setColor(0x77716a);
  m.box(boiler.x, boiler.h, boiler.z, boiler.w + 0.4, 0.5, boiler.d + 0.4);
  if (!far) {
    m.setColor(0x5d5a55);
    for (let i = 0; i < 4; i++) m.box(boiler.x - boiler.w * 0.36 + i * boiler.w * 0.24, boiler.h * 0.3, boiler.z + boiler.d / 2 + 0.05, 1.2 * k + 0.4, boiler.h * 0.55, 0.15);
    m.setColor(DARK_STEEL);
    m.box(boiler.x + boiler.w * 0.1, hall.h + 1.2, (boiler.z + hall.z) / 2, 1.2, 1.2, 8 * k);
  }

  // Chimney stacks banded red / white, a beacon housing on top.
  for (const st of plantStacks(s)) {
    const bands = 5, r0 = 2.7 * k + 0.6, r1 = 1.7 * k + 0.4, n = far ? 7 : 12;
    for (let b = 0; b < bands; b++) {
      m.setColor(b % 2 ? PAINT_WHITE : PAINT_RED);
      const t0 = b / bands, t1 = (b + 1) / bands;
      frustumAt(m, st.x, st.z, st.height * t0, r0 + (r1 - r0) * t0, r0 + (r1 - r0) * t1, st.height / bands, n);
    }
    m.setColor(0x030303);
    m.cylinder(st.x, st.height, st.z, r1 * 1.9, 0.04, n); // black flue mouth (an open top would show the ground through)
    m.setColor(0x7a1410);
    m.box(st.x + r1 * 0.9, st.height, st.z, 0.5, 0.7, 0.5); // beacon housing on the rim (the light itself is a LightDef)
  }
  // Cooling towers (hyperbolic) or, without them, an air-cooled condenser bank.
  const towerSpots = coolerSpots(k);
  if (s.coolers === 0) {
    m.setColor(0x9aa0a4);
    m.box(towerSpots[0][0], 0, towerSpots[0][1], 16 * k, 11 * hs, 12 * k);
    m.setColor(0x4a4f55);
    for (let i = 0; i < 3; i++) m.box(towerSpots[0][0] - 5 * k + i * 5 * k, 11 * hs, towerSpots[0][1], 3.6 * k, 0.4, 9 * k);
  } else {
    for (let t = 0; t < Math.min(2, s.coolers); t++) {
      const [tx, tz, R] = towerSpots[t];
      const H = 48 * hs, steps = far ? 4 : 10, n = far ? 10 : 20;
      const radius = (f: number) => R * (1 - 0.32 * Math.sin(Math.min(1, f / 0.72) * Math.PI / 2) + 0.1 * Math.max(0, f - 0.72) / 0.28);
      m.setColor(0xb8b4ac);
      for (let i = 0; i < steps; i++) {
        const f0 = i / steps, f1 = (i + 1) / steps;
        for (let a = 0; a < n; a++) {
          const a0 = (a / n) * Math.PI * 2, a1 = ((a + 1) / n) * Math.PI * 2, mid = (a0 + a1) / 2;
          const r0 = radius(f0), r1 = radius(f1);
          m.face(
            [[tx + Math.cos(a0) * r0, f0 * H, tz + Math.sin(a0) * r0], [tx + Math.cos(a1) * r0, f0 * H, tz + Math.sin(a1) * r0],
              [tx + Math.cos(a1) * r1, f1 * H, tz + Math.sin(a1) * r1], [tx + Math.cos(a0) * r1, f1 * H, tz + Math.sin(a0) * r1]],
            [Math.cos(mid), 0, Math.sin(mid)],
          );
        }
      }
      // Black circle closing the top: the tower is hollow, so from above it would otherwise show the ground through it.
      m.setColor(0x030303);
      m.cylinder(tx, H, tz, radius(1) * 1.94, 0.05, n);
    }
  }
  // Fuel tanks.
  m.setColor(0xcfcfc8);
  for (const z of [12 * k, 19 * k]) m.cylinder(4 * k, 0, z, 6 * k + 0.6, 7 * hs, far ? 8 : 14);

  // Switchyard: transformers under the gantry, where the high-voltage line ends.
  for (const x of [-26, -16, -6]) transformer(m, x * k, 16 * k, far, Math.max(0.8, k));
  gantry(m, s, far);
  lampPosts(m, s, far);
}
