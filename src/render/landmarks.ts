// Landmark layer: the map's lighthouses (beaches) and telecommunication towers (mountains).
//
// Each structure is one world-space vertex-coloured mesh pair, switched by camera distance: a detailed near mesh (railing,
// lattice braces, panels, door...) and a simple far one (a few tapered boxes), both drawn with the building shaders. They are
// few (at most 4 + 3 per map), so there is no per-chunk merging.
//
// Lighting goes through the LightField (never ad-hoc lights), in `animated` groups (chunks/anim.glsl):
//   - lighthouse: two opposite spot lights turn once per `period` (deferred light on the ground and the sea, a light ray from
//     each, and a halo that flashes when the beam points at the camera), plus a faint steady lantern glow; the lantern room
//     glass glows at night. On from dusk to dawn.
//   - tower: red beacons at the top and on the platforms flash together (a point light and a halo each), on all day, brighter
//     at night.

import * as THREE from 'three';
import { hash32, mulberry32 } from '../core/rng.ts';
import type { Lighthouse, RadioTower } from '../terrain/generate.ts';
import type { Environment } from './world.ts';
import type { ChunkGrid } from './culling.ts';
import type { LightDef, LightField, LightGroup } from './lights.ts';
import { MeshData, WIN_NONE, WIN_SIGN } from './buildings/geometry.ts';
import nearVertex from './shaders/building.vert.glsl';
import nearFragment from './shaders/building.frag.glsl';

/** Camera distance (m) where the detailed meshes give way to the simple ones. */
const NEAR_DISTANCE = 450;
/** Beacons and beams are on from dusk to dawn (same curve as the street lights); beacons keep a day level. */
const ON_DAYLIGHT = 0.65;
const OFF_DAYLIGHT = 0.25;
const TOWER_DAY_LEVEL = 0.4;

const WHITE = 0xf0ede4;
const RED = 0xb3302a;
const BLACK = 0x2b2b30;
const CONCRETE = 0x9a978f;
const STEEL = 0x8c9399;
const GLASS = 0xffe6a0;

export type V3 = [number, number, number];

/**
 * Lighthouse beams: two soft rays turning round the lantern, like a street lamp's ray but sweeping (no spot light: nothing
 * is lit by them). Warm white; each cone is only BEAM_LENGTH (25 m) long, fading to nothing at its end, 12 deg half angle, faint.
 */
const BEAM_COLOR = new THREE.Color().setRGB(1.0, 0.88, 0.62, THREE.LinearSRGBColorSpace);
const BEAM_INTENSITY = 2.5;
const BEAM_RADIUS = 40;
const BEAM_ANGLE = THREE.MathUtils.degToRad(24);
const BEAM_DIR = new THREE.Vector3(0, -0.5, 1).normalize();
/** Ray length (m): it only reaches this far round the lantern, not down to the ground. */
const BEAM_LENGTH = 25;
/** Light-ray strength of a beam relative to its light (peak opacity ~ 0.075 at the lamp, see CONE_STRENGTH in ray.frag.glsl). */
const BEAM_SHAFT = 1;
/** Far halo disc of a beam (m); it flashes when the beam points at the camera. */
const BEAM_HALO = 3;
/** Steady lantern halo (m) and its brightness. */
const GLOW_HALO = 1.6;
const GLOW_INTENSITY = 1.4;
/** Red obstruction beacons. */
const BEACON_COLOR = new THREE.Color().setRGB(1.0, 0.05, 0.03, THREE.LinearSRGBColorSpace);
const BEACON_INTENSITY = 4;
const BEACON_RADIUS = 14;
const BEACON_DUTY = 0.2;

export class LandmarkLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  private beams: LightGroup;
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
    this.beams = field.createGroup(false, true);
    this.beacons = field.createGroup(false, true);
    // Halos at full strength before the near meshes give way (see CLAUDE.md, light halos).
    this.beams.setHaloRange(NEAR_DISTANCE * 0.1, NEAR_DISTANCE * 0.45);
    this.beacons.setHaloRange(NEAR_DISTANCE * 0.1, NEAR_DISTANCE * 0.45);
  }

  /** Builds the meshes and lights of the map's lighthouses and towers (replacing the previous ones). */
  build(lighthouses: Lighthouse[], towers: RadioTower[], grid: ChunkGrid): void {
    this.clear(false);
    const beamDefs: LightDef[] = [], beaconDefs: LightDef[] = [];
    for (const l of lighthouses) {
      this.addMeshes(l.x, l.y, l.z, (m, far) => buildLighthouse(m, l, far));
      const lamp = new THREE.Vector3(l.x, l.y + l.height + (LANTERN_FLOOR + LAMP_HEIGHT) / 2, l.z); // middle of the lantern room
      for (let n = 0; n < 2; n++) {
        beamDefs.push({
          x: lamp.x, y: lamp.y, z: lamp.z, radius: BEAM_RADIUS, color: BEAM_COLOR, intensity: BEAM_INTENSITY,
          dir: BEAM_DIR, angle: BEAM_ANGLE, groundY: l.y, shaft: BEAM_SHAFT, rayLength: BEAM_LENGTH, haloSize: BEAM_HALO, rayOnly: true,
          anim: { kind: 'rotate', period: l.period, phase: l.phase + (n * l.period) / 2 },
        });
      }
      beamDefs.push({ x: lamp.x, y: lamp.y, z: lamp.z, haloSize: GLOW_HALO, radius: BEAM_RADIUS, color: BEAM_COLOR, intensity: GLOW_INTENSITY, groundY: l.y, rayOnly: true });
    }
    for (const t of towers) {
      this.addMeshes(t.x, t.y, t.z, (m, far) => buildTower(m, t, far));
      for (const y of beaconHeights(t)) {
        beaconDefs.push({
          x: t.x, y: t.y + y, z: t.z, radius: BEACON_RADIUS, color: BEACON_COLOR, intensity: BEACON_INTENSITY, groundY: t.y,
          anim: { kind: 'blink', period: t.period, phase: t.phase, duty: BEACON_DUTY },
        });
      }
    }
    this.beams.build(beamDefs, grid);
    this.beacons.build(beaconDefs, grid);
    this.level = -1;
  }

  /** The structure at (x, y, z): a near and a far mesh in world space, switched by distance. */
  private addMeshes(x: number, y: number, z: number, draw: (m: MeshData, far: boolean) => void): void {
    const center = new THREE.Vector3(x, y, z);
    for (const far of [false, true]) {
      const m = new MeshData({ aWin: 2, aKey: 4 });
      m.frame(x, y, z, 0);
      m.cur.aWin = [WIN_NONE, 0];
      draw(m, far);
      const mesh = new THREE.Mesh(m.toGeometry(), this.material);
      mesh.userData.lodCenter = center;
      if (far) mesh.userData.lodMin = NEAR_DISTANCE;
      else mesh.userData.lodMax = NEAR_DISTANCE;
      this.group.add(mesh);
    }
  }

  /** Lamp levels follow the daylight (0 night - 1 day): beams on at night, beacons dimmer by day. */
  update(daylight: number): void {
    const night = 1 - THREE.MathUtils.smoothstep(daylight, OFF_DAYLIGHT, ON_DAYLIGHT);
    if (night === this.level) return;
    this.level = night;
    this.material.uniforms.lampLevel.value = night;
    this.beams.level = night;
    this.beacons.level = TOWER_DAY_LEVEL + (1 - TOWER_DAY_LEVEL) * night;
  }

  /** Drops every mesh (and, unless `lights` is false, the lights) of the current map. */
  clear(lights = true): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      this.group.remove(child);
    }
    if (lights) {
      this.beams.clear();
      this.beacons.clear();
    }
  }
}

/** Distance of the lighthouse lamp above the top of the tower body (gallery + lantern room). */
const LAMP_HEIGHT = 2.6;
/** Where the lantern room starts above the tower top (gallery deck + plinth). */
const LANTERN_FLOOR = 0.85;

/** Heights (above the foot) of a tower's beacons: the antenna tip and the two platforms below it. */
function beaconHeights(t: RadioTower): number[] {
  return [t.height + ANTENNA_HEIGHT, t.height * 0.66, t.height * 0.33];
}
const ANTENNA_HEIGHT = 3;

// ---------------------------------------------------------------------------------------------------------------------
// Geometry helpers (local frame: origin at the structure's foot)

/** Tapered upright prism / cylinder from radius r0 at y0 to r1 at y0 + h (no caps). */
export function frustum(m: MeshData, y0: number, r0: number, r1: number, h: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, mid = (a0 + a1) / 2;
    m.face(
      [[Math.cos(a0) * r0, y0, Math.sin(a0) * r0], [Math.cos(a1) * r0, y0, Math.sin(a1) * r0],
        [Math.cos(a1) * r1, y0 + h, Math.sin(a1) * r1], [Math.cos(a0) * r1, y0 + h, Math.sin(a0) * r1]],
      [Math.cos(mid), 0, Math.sin(mid)],
    );
  }
}

/** Flat disc (n-gon) at height y facing up (or down). */
export function disc(m: MeshData, y: number, r: number, n: number, up = true): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    m.face([[0, y, 0], [Math.cos(a0) * r, y, Math.sin(a0) * r], [Math.cos(a1) * r, y, Math.sin(a1) * r]], [0, up ? 1 : -1, 0]);
  }
}

/** Cone from radius r at y0 up to a point at y0 + h. */
export function cone(m: MeshData, y0: number, r: number, h: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, mid = (a0 + a1) / 2;
    m.face(
      [[Math.cos(a0) * r, y0, Math.sin(a0) * r], [Math.cos(a1) * r, y0, Math.sin(a1) * r], [0, y0 + h, 0]],
      [Math.cos(mid) * h, r, Math.sin(mid) * h],
    );
  }
}

/** Thin square-section strut between two points (t = side length). */
export function strut(m: MeshData, a: V3, b: V3, t: number): void {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  if (len < 1e-6) return;
  const f: V3 = [d[0] / len, d[1] / len, d[2] / len];
  // Any vector not parallel to the strut gives the two side directions.
  const ref: V3 = Math.abs(f[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [f[1] * ref[2] - f[2] * ref[1], f[2] * ref[0] - f[0] * ref[2], f[0] * ref[1] - f[1] * ref[0]];
  const ul = Math.hypot(...u);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
  const h = t / 2;
  const at = (p: V3, su: number, sv: number): V3 => [p[0] + (u[0] * su + v[0] * sv) * h, p[1] + (u[1] * su + v[1] * sv) * h, p[2] + (u[2] * su + v[2] * sv) * h];
  m.face([at(a, 1, 1), at(a, 1, -1), at(b, 1, -1), at(b, 1, 1)], u);
  m.face([at(a, -1, 1), at(a, -1, -1), at(b, -1, -1), at(b, -1, 1)], [-u[0], -u[1], -u[2]]);
  m.face([at(a, 1, 1), at(a, -1, 1), at(b, -1, 1), at(b, 1, 1)], v);
  m.face([at(a, 1, -1), at(a, -1, -1), at(b, -1, -1), at(b, 1, -1)], [-v[0], -v[1], -v[2]]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Lighthouse

/** Body colours by style: stripes alternate [first, second]; roof colour of the lantern room. */
const LIGHTHOUSE_STYLES: { bands: [number, number]; roof: number }[] = [
  { bands: [WHITE, RED], roof: RED },
  { bands: [WHITE, BLACK], roof: BLACK },
  { bands: [WHITE, WHITE], roof: RED },
];

function buildLighthouse(m: MeshData, l: Lighthouse, far: boolean): void {
  const style = LIGHTHOUSE_STYLES[hash32(l.seed, 5) % LIGHTHOUSE_STYLES.length];
  const rng = mulberry32(hash32(l.seed, 6));
  const sides = far ? 8 : 16;
  const top = l.radius * 0.62; // radius under the gallery
  const bands = 5 + Math.floor(rng() * 2);
  const bandH = l.height / bands;

  // Foundation block, then the tapering banded body.
  m.setColor(CONCRETE, 0.8);
  m.cylinder(0, -1.5, 0, l.radius * 2 + 1.2, 2.1, far ? 8 : 14);
  for (let b = 0; b < bands; b++) {
    const t0 = b / bands, t1 = (b + 1) / bands;
    m.setColor(style.bands[b % 2]);
    frustum(m, b * bandH, l.radius + (top - l.radius) * t0, l.radius + (top - l.radius) * t1, bandH, sides);
  }

  // Gallery: a deck wider than the tower with a railing, then the lantern room on it.
  const gy = l.height;
  m.setColor(CONCRETE, 0.9);
  m.cylinder(0, gy, 0, top * 2 + 1.8, 0.35, sides);
  if (!far) {
    m.setColor(STEEL);
    const posts = 14, rr = top + 0.8;
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * Math.PI * 2;
      m.box(Math.cos(a) * rr, gy + 0.35, Math.sin(a) * rr, 0.08, 1.05, 0.08);
    }
    for (const y of [gy + 0.7, gy + 1.35]) frustum(m, y, rr + 0.03, rr + 0.03, 0.06, 14);
  }
  m.setColor(CONCRETE, 0.7);
  m.cylinder(0, gy + 0.35, 0, top * 1.5, 0.5, sides); // lantern plinth
  // Lantern room: glass that glows at night (WIN_SIGN: lit by lampLevel), thin mullions, a dark roof and a vane.
  const ly = gy + LANTERN_FLOOR, lr = top * 0.7, lh = LAMP_HEIGHT - LANTERN_FLOOR;
  m.cur.aWin = [WIN_SIGN, 1];
  m.setColor(GLASS, 0.9);
  frustum(m, ly, lr, lr, lh, 10);
  m.cur.aWin = [WIN_NONE, 0];
  if (!far) {
    m.setColor(STEEL, 0.7);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      m.box(Math.cos(a) * (lr + 0.03), ly, Math.sin(a) * (lr + 0.03), 0.07, lh, 0.07);
    }
  }
  m.setColor(style.roof, 0.85);
  disc(m, ly + lh, lr + 0.35, 10);
  cone(m, ly + lh, lr + 0.35, lr * 0.9, 10);
  if (!far) {
    m.setColor(STEEL);
    m.box(0, ly + lh + lr * 0.9, 0, 0.08, 1.1, 0.08);
  }

  if (!far) {
    // Door at the foot and a few slit windows up the body, on the side facing +Z.
    m.setColor(0x3a2a20);
    m.box(0, 0, l.radius - 0.05, 1.2, 2.1, 0.25);
    m.setColor(BLACK, 0.8);
    for (let i = 1; i < 4; i++) {
      const y = (l.height * i) / 4 - 0.5, r = l.radius + (top - l.radius) * (i / 4);
      m.box(0, y, r - 0.1, 0.4, 1.0, 0.2);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Telecommunication tower

const PAINT_RED = 0xc0392b;
const PAINT_WHITE = 0xe6e3dc;

function buildTower(m: MeshData, t: RadioTower, far: boolean): void {
  const rng = mulberry32(hash32(t.seed, 6));
  const H = t.height;
  const baseHalf = t.width / 2, topHalf = baseHalf * 0.22;
  const half = (y: number) => baseHalf + (topHalf - baseHalf) * (y / H); // half width at height y
  const levels = far ? 2 : Math.max(5, Math.round(H / 5));
  const ys = Array.from({ length: levels + 1 }, (_, i) => (i / levels) * H);
  const corner = (y: number, sx: number, sz: number): V3 => [sx * half(y), y, sz * half(y)];
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  m.setColor(CONCRETE, 0.75);
  m.box(0, -1.2, 0, t.width + 1.6, 1.6, t.width + 1.6); // foundation
  // Legs, painted in alternating red / white sections (aviation marking).
  const leg = far ? 0.5 : 0.3;
  for (const [sx, sz] of corners) {
    for (let i = 0; i < levels; i++) {
      m.setColor(i % 2 ? PAINT_WHITE : PAINT_RED);
      strut(m, corner(ys[i], sx, sz), corner(ys[i + 1], sx, sz), leg);
    }
  }
  if (!far) {
    // Ring braces at every level and X braces between levels on the four faces.
    m.setColor(STEEL);
    for (let i = 0; i <= levels; i++) {
      for (let c = 0; c < 4; c++) {
        const [ax, az] = corners[c], [bx, bz] = corners[(c + 1) % 4];
        strut(m, corner(ys[i], ax, az), corner(ys[i], bx, bz), 0.12);
        if (i < levels) {
          strut(m, corner(ys[i], ax, az), corner(ys[i + 1], bx, bz), 0.09);
          strut(m, corner(ys[i], bx, bz), corner(ys[i + 1], ax, az), 0.09);
        }
      }
    }
  }

  // Platforms (two, under the beacons' heights) with railings, and the antenna on top.
  m.setColor(STEEL, 0.85);
  for (const f of [0.33, 0.66]) {
    const y = H * f, w = half(y) * 2 + 1.2;
    m.box(0, y, 0, w, 0.18, w);
    if (!far) for (const [sx, sz] of corners) m.box(sx * (w / 2 - 0.05), y + 0.18, sz * (w / 2 - 0.05), 0.05, 0.9, 0.05);
  }
  m.setColor(PAINT_WHITE);
  m.box(0, H, 0, topHalf * 2 + 0.8, 0.6, topHalf * 2 + 0.8); // top platform
  m.setColor(PAINT_RED);
  m.box(0, H + 0.6, 0, 0.25, ANTENNA_HEIGHT - 0.6, 0.25); // antenna mast
  // Beacon lamps (dark red housings; the light itself is a LightDef).
  m.setColor(0x7a1410);
  for (const y of beaconHeights(t)) m.box(0, y - 0.1, 0, 0.32, 0.32, 0.32);

  // Panel antennas on the faces under the upper platform, and the equipment cabin at the foot.
  if (!far) {
    m.setColor(0xd6d6d2);
    const rows = [0.4, 0.55, 0.9];
    for (const f of rows) {
      const y = H * f;
      const n = 2 + Math.floor(rng() * 2);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + rng();
        const r = half(y) + 0.7;
        m.box(Math.cos(a) * r, y, Math.sin(a) * r, 0.2, 1.3, 0.55, -a);
      }
    }
    m.setColor(CONCRETE, 0.95);
    m.box(t.width * 0.5 + 2.2, 0, 0, 2.6, 2.2, 2.2);
    m.setColor(0x3a3a3c);
    m.box(t.width * 0.5 + 0.88, 0, 0, 0.1, 1.7, 0.9); // door
  } else {
    m.setColor(CONCRETE, 0.95);
    m.box(t.width * 0.5 + 2.2, 0, 0, 2.6, 2.2, 2.2);
  }
}
