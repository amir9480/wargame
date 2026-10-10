// Building meshes from a BuildingSpec (terrain/buildings/spec.ts): raw vertex data in world space, appended
// building by building into one buffer per map chunk.
//
//   near   -> every part with its details: window panes with sills, doors, balconies, awnings, pumps... Abandoned
//             buildings get a broken top floor, dropped roofs, dark / boarded windows and debris.
//   far    -> one box per wall block and the roof shapes; windows are drawn by the shader from a facade grid
//             (aFacade / aGrid), lit at night with a soft glow around each window.
//   rubble -> a debris pile over the footprint, shown instead of the building once it is destroyed.
//
// Cosmetic randomness (ruin shapes, debris) is seeded from the building's own seed. Window lights are decided in the
// shaders (chunks/windows.glsl) from the window's key (column, floor, wall + 4 * block) and the building's seed hash,
// which both levels of detail and the halos carry, so a window is the same lit / dark window at every distance.

import * as THREE from 'three';
import { hash32, mulberry32, type Rng } from '../../core/rng.ts';
import { buildingSpec, type Building, type BuildingSpec, type Part, type WindowGrid } from '../../terrain/generate.ts';

/** Window / emissive kind in `aWin.x`. */
export const WIN_NONE = 0;
export const WIN_GLASS = 1;
export const WIN_SIGN = 2;

/** Walls reach this far below the pad so they never float over the terrain mesh. */
const FOUNDATION = 1.5;
/** Panes and doors sit this far in front of their wall. */
const PANE_OFFSET = 0.04;

type V3 = [number, number, number];

/** Growing vertex buffers with a local building frame (yaw + translation) applied to every vertex. */
export class MeshData {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** Extra per-vertex attributes, filled from `cur` (or per-vertex overrides). */
  extra: Record<string, { size: number; data: number[] }>;
  cur: Record<string, number[]>;
  color: V3 = [1, 1, 1];
  private c = 1;
  private s = 0;
  private o: V3 = [0, 0, 0];

  constructor(extra: Record<string, number>) {
    this.extra = {};
    this.cur = {};
    for (const [name, size] of Object.entries(extra)) {
      this.extra[name] = { size, data: [] };
      this.cur[name] = new Array(size).fill(0);
    }
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Local frame of the next vertices: building origin and yaw (local +Z -> (sin, cos) in world XZ). */
  frame(x: number, y: number, z: number, yaw: number): void {
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
    this.o = [x, y, z];
  }

  setColor(hex: number, f = 1): void {
    const c = new THREE.Color(hex); // sRGB hex -> linear working colour
    this.color = [c.r * f, c.g * f, c.b * f];
  }

  private vertex(p: V3, n: V3, extras?: Record<string, number[]>): number {
    const { c, s, o } = this;
    this.pos.push(o[0] + p[0] * c + p[2] * s, o[1] + p[1], o[2] - p[0] * s + p[2] * c);
    this.nor.push(n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c);
    this.col.push(...this.color);
    for (const [name, a] of Object.entries(this.extra)) a.data.push(...(extras?.[name] ?? this.cur[name]));
    return this.pos.length / 3 - 1;
  }

  /**
   * Flat polygon (3 or 4 corners, local frame) facing `out`: the winding is fixed up so it is front-facing from
   * that side. `extras[i]` overrides the per-vertex extra attributes of corner i.
   */
  face(pts: V3[], out: V3, extras?: Record<string, number[]>[]): void {
    const [a, b, c] = pts;
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) return;
    n = [n[0] / len, n[1] / len, n[2] / len];
    let order = pts.map((_, i) => i);
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) {
      order = order.reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const ids = order.map((i) => this.vertex(pts[i], n, extras?.[i]));
    this.idx.push(ids[0], ids[1], ids[2]);
    if (ids.length === 4) this.idx.push(ids[0], ids[2], ids[3]);
  }

  /** Axis-aligned box (in the local frame, optionally turned by `rot` about its own centre); bottom face left out. */
  box(cx: number, y0: number, cz: number, w: number, h: number, d: number, rot = 0, bottom = false): void {
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (x: number, y: number, z: number): V3 => [cx + x * c + z * s, y0 + y, cz - x * s + z * c];
    const N = (x: number, y: number, z: number): V3 => [x * c + z * s, y, -x * s + z * c];
    const hw = w / 2, hd = d / 2;
    this.face([P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, hd), P(-hw, h, hd)], N(0, 0, 1));
    this.face([P(-hw, 0, -hd), P(hw, 0, -hd), P(hw, h, -hd), P(-hw, h, -hd)], N(0, 0, -1));
    this.face([P(hw, 0, -hd), P(hw, 0, hd), P(hw, h, hd), P(hw, h, -hd)], N(1, 0, 0));
    this.face([P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, hd), P(-hw, h, -hd)], N(-1, 0, 0));
    this.face([P(-hw, h, -hd), P(hw, h, -hd), P(hw, h, hd), P(-hw, h, hd)], [0, 1, 0]);
    if (bottom) this.face([P(-hw, 0, -hd), P(hw, 0, -hd), P(hw, 0, hd), P(-hw, 0, hd)], [0, -1, 0]);
  }

  /** Upright cylinder (diameter w, n sides) with a top cap. */
  cylinder(cx: number, y0: number, cz: number, w: number, h: number, n = 12): void {
    const r = w / 2;
    const at = (i: number): [number, number] => [cx + Math.cos((i / n) * Math.PI * 2) * r, cz + Math.sin((i / n) * Math.PI * 2) * r];
    for (let i = 0; i < n; i++) {
      const [x0, z0] = at(i), [x1, z1] = at(i + 1);
      const mid = ((i + 0.5) / n) * Math.PI * 2;
      this.face([[x0, y0, z0], [x1, y0, z1], [x1, y0 + h, z1], [x0, y0 + h, z0]], [Math.cos(mid), 0, Math.sin(mid)]);
      this.face([[cx, y0 + h, cz], [x0, y0 + h, z0], [x1, y0 + h, z1]], [0, 1, 0]);
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    for (const [name, a] of Object.entries(this.extra)) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(a.data), a.size));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    return g;
  }
}

/** Vertex range [start, start + count) of one building in a chunk buffer. */
export interface Span {
  start: number;
  count: number;
}

/** How an abandoned building is ruined (same for both detail levels). */
interface Ruin {
  rng: Rng;
  /** Roof parts left out. */
  dropRoof: boolean;
  /** The block whose top floor is broken off (null: walls intact). */
  block: Part | null;
}

function ruinOf(b: Building, spec: BuildingSpec): Ruin | null {
  if (b.condition !== 'abandoned') return null;
  const rng = mulberry32(hash32(b.seed, 0xdead));
  const dropRoof = rng() < 0.6, broken = rng() < 0.75;
  return { rng, dropRoof, block: broken ? brokenBlock(spec) : null };
}

/** The block a ruin breaks: the highest-reaching windowed one (an office tower, not its podium), else the first. */
function brokenBlock(spec: BuildingSpec): Part | null {
  let best: Part | null = null;
  for (const p of spec.parts) {
    if (p.kind !== 'block') continue;
    if (!best || (p.windows && (!best.windows || p.y + p.h > best.y + best.h))) best = p;
  }
  return best;
}

const ROOF_KINDS = new Set(['gable', 'hip', 'shed', 'saw']);
/** Abandoned walls: darker, greyer. */
const RUIN_TINT = 0.62;
/** Charred floor left on top of a ruin's broken block (both detail levels). */
const RUIN_FLOOR: V3 = [0.03, 0.03, 0.028];
/** Parts this far outside a broken block's walls still hang on them (eaves, balconies, signs) and fall with them. */
const RUIN_REACH = 1.5;

/** Part left out of a ruin: dropped roofs, and everything above the broken block's break line over its footprint. */
function fallen(p: Part, ruin: Ruin | null): boolean {
  if (!ruin) return false;
  if (ruin.dropRoof && ROOF_KINDS.has(p.kind)) return true;
  const block = ruin.block;
  if (!block || p === block) return false;
  return p.y >= solidTopOf(block, true) - 0.01
    && Math.abs(p.x - block.x) < block.w / 2 + RUIN_REACH && Math.abs(p.z - block.z) < block.d / 2 + RUIN_REACH;
}

/** Wall faces of a block: start corner, direction along the wall and outward normal (local frame), face bit. */
function walls(p: Part): { o: V3; dir: V3; out: V3; len: number; bit: number }[] {
  const hw = p.w / 2, hd = p.d / 2;
  return [
    { o: [p.x - hw, 0, p.z + hd], dir: [1, 0, 0], out: [0, 0, 1], len: p.w, bit: 1 },
    { o: [p.x + hw, 0, p.z - hd], dir: [-1, 0, 0], out: [0, 0, -1], len: p.w, bit: 2 },
    { o: [p.x + hw, 0, p.z + hd], dir: [0, 0, -1], out: [1, 0, 0], len: p.d, bit: 4 },
    { o: [p.x - hw, 0, p.z - hd], dir: [0, 0, 1], out: [-1, 0, 0], len: p.d, bit: 8 },
  ];
}

/** Window columns along a wall of length `len`: centre offsets (u). The far shader rebuilds them from (start, count). */
function columns(len: number, g: WindowGrid): number[] {
  const n = Math.floor((len - 0.8) / g.spacing);
  if (n < 1) return [];
  const start = (len - (n - 1) * g.spacing) / 2;
  return Array.from({ length: n }, (_, i) => start + i * g.spacing);
}

/** Building hash (0..1) that seeds its window schedules (shaders). */
export function windowSeed(b: Building): number {
  return (hash32(b.seed, 0x5eed) % 10007) / 10007;
}

/** Index of each windowed block of a spec (part of every window key). */
function blockIndex(spec: BuildingSpec): Map<Part, number> {
  return new Map(spec.parts.filter((p) => p.kind === 'block' && p.windows).map((p, i) => [p, i]));
}

/** Top of a block's standing walls (a ruin's broken top floor is gone). */
function solidTopOf(p: Part, broken: boolean): number {
  const fh = p.windows?.floorHeight ?? p.h;
  return broken ? p.y + Math.max(fh * 0.6, p.h - fh) : p.y + p.h;
}

/** Floors whose windows fit under `top`. */
function floorsUnder(p: Part, g: WindowGrid, top: number): number {
  let n = 0;
  while (n < g.floors && p.y + n * g.floorHeight + g.sill + g.height <= top + 0.01) n++;
  return n;
}

/** Door centres along the front wall (length `len`). */
function doorCentres(p: Part, len: number): number[] {
  const d = p.doors;
  return d ? Array.from({ length: d.count }, (_, i) => ((i + 0.5) / d.count) * len) : [];
}

/** A ground-floor window at `u` of the front wall gives way to a door (same rule in buildingFar.frag). */
function doorBlocks(p: Part, g: WindowGrid, len: number, u: number): boolean {
  const d = p.doors;
  if (!d || p.y > 0.05 || g.sill >= d.height) return false;
  return doorCentres(p, len).some((du) => Math.abs(du - u) < (d.width + g.width) / 2 + 0.2);
}

/**
 * Near (detailed) building: appends to `m`. Extras: aWin = [kind, lit share], aKey = [column, floor, wall + 4 * block,
 * building seed hash] (window panes; see chunks/windows.glsl).
 */
export function buildNear(m: MeshData, b: Building, spec: BuildingSpec = buildingSpec(b.seed, b.type)): void {
  m.frame(b.x, b.y, b.z, b.yaw);
  if (b.condition === 'construction') {
    m.cur.aWin = [WIN_NONE, 0];
    m.cur.aKey = [0, 0, 0, 0];
    buildSite(m, b, spec, false);
    return;
  }
  const ruin = ruinOf(b, spec);
  const tint = ruin ? RUIN_TINT : 1;
  const boards = mulberry32(hash32(b.seed, 0xb0a7d));
  const blocks = blockIndex(spec);
  const seed = windowSeed(b);
  m.cur.aWin = [WIN_NONE, 0];
  m.cur.aKey = [0, 0, 0, seed];

  for (const p of spec.parts) {
    // A broken top floor takes whatever stood on / hung from it down with it.
    if (fallen(p, ruin)) continue;
    m.setColor(p.color, tint);
    m.cur.aWin = p.glow && !ruin ? [WIN_SIGN, 1] : [WIN_NONE, 0];
    switch (p.kind) {
      case 'block':
        nearBlock(m, p, spec, blocks.get(p) ?? 0, seed, boards, ruin && p === ruin.block ? ruin : null, !!ruin);
        break;
      case 'slab': {
        const bottom = p.y > 0.05;
        m.box(p.x, p.y, p.z, p.w, p.h, p.d, 0, bottom);
        break;
      }
      case 'cylinder':
        m.cylinder(p.x, p.y, p.z, p.w, p.h);
        break;
      default:
        roof(m, p, spec, !!ruin);
    }
  }
  if (ruin) debris(m, spec, ruin.rng, 0.6);
}

/** Wall block with window panes + sills, doors, foundation; a ruin's top floor is a broken edge over a charred floor. */
function nearBlock(
  m: MeshData, p: Part, spec: BuildingSpec, block: number, seed: number, boards: Rng, ruin: Ruin | null, dark: boolean,
): void {
  const g = p.windows;
  const y0 = p.y > 0.05 ? p.y : -FOUNDATION;
  const solidTop = solidTopOf(p, !!ruin);
  const wallColor = m.color;
  const doors = p.doors;

  walls(p).forEach((wall, wallIdx) => {
    const at = (u: number, y: number, off = 0): V3 => [
      wall.o[0] + wall.dir[0] * u + wall.out[0] * off,
      y,
      wall.o[2] + wall.dir[2] * u + wall.out[2] * off,
    ];
    m.color = wallColor;
    m.cur.aWin = [WIN_NONE, 0];
    m.face([at(0, y0), at(wall.len, y0), at(wall.len, solidTop), at(0, solidTop)], wall.out);
    if (ruin) {
      // Jagged broken top: wall pieces of random height.
      const pieces = Math.max(2, Math.round(wall.len / 1.6));
      for (let i = 0; i < pieces; i++) {
        const u0 = (i / pieces) * wall.len, u1 = ((i + 1) / pieces) * wall.len;
        const top = solidTop + (p.y + p.h - solidTop) * ruin.rng() * ruin.rng();
        if (top > solidTop + 0.1) m.face([at(u0, solidTop), at(u1, solidTop), at(u1, top), at(u0, top)], wall.out);
      }
    }

    // Doors on the front.
    if (doors && p.y <= 0.05 && wall.bit === 1) {
      for (const u of doorCentres(p, wall.len)) {
        m.setColor(doors.color, dark ? 0.5 : 1);
        m.face([at(u - doors.width / 2, 0, PANE_OFFSET), at(u + doors.width / 2, 0, PANE_OFFSET), at(u + doors.width / 2, doors.height, PANE_OFFSET), at(u - doors.width / 2, doors.height, PANE_OFFSET)], wall.out);
      }
    }

    if (!g || !(g.faces & wall.bit)) return;
    const floors = floorsUnder(p, g, solidTop);
    for (let f = 0; f < floors; f++) {
      const wy0 = p.y + f * g.floorHeight + g.sill, wy1 = wy0 + g.height;
      columns(wall.len, g).forEach((u, col) => {
        if (f === 0 && wall.bit === 1 && doorBlocks(p, g, wall.len, u)) return;
        const a = u - g.width / 2, b = u + g.width / 2;
        // Abandoned: dark broken panes or boarded up.
        if (dark) m.setColor(boards() < 0.35 ? 0x6b5a45 : 0x141516);
        else m.setColor(g.glass);
        m.cur.aWin = dark ? [WIN_NONE, 0] : [WIN_GLASS, spec.litShare];
        m.cur.aKey = [col, f, wallIdx + 4 * block, seed];
        m.face([at(a, wy0, PANE_OFFSET), at(b, wy0, PANE_OFFSET), at(b, wy1, PANE_OFFSET), at(a, wy1, PANE_OFFSET)], wall.out);
        // Sill: top and front of a thin ledge under the pane.
        m.color = wallColor.map((v) => v * 0.8) as V3;
        m.cur.aWin = [WIN_NONE, 0];
        m.face([at(a - 0.1, wy0, 0), at(b + 0.1, wy0, 0), at(b + 0.1, wy0, 0.16), at(a - 0.1, wy0, 0.16)], [0, 1, 0]);
        m.face([at(a - 0.1, wy0 - 0.12, 0.16), at(b + 0.1, wy0 - 0.12, 0.16), at(b + 0.1, wy0, 0.16), at(a - 0.1, wy0, 0.16)], wall.out);
      });
    }
  });
  // Top: roof deck, or a charred floor inside a broken ruin.
  m.color = ruin ? [...RUIN_FLOOR] : (wallColor.map((v) => v * 0.7) as V3);
  m.cur.aWin = [WIN_NONE, 0];
  const hw = p.w / 2, hd = p.d / 2;
  m.face([[p.x - hw, solidTop, p.z - hd], [p.x + hw, solidTop, p.z - hd], [p.x + hw, solidTop, p.z + hd], [p.x - hw, solidTop, p.z + hd]], [0, 1, 0]);
}

/** Roof shapes (gable / hip / shed / saw); end walls of gables take the building's wall colour. */
function roof(m: MeshData, p: Part, spec: BuildingSpec, dark: boolean): void {
  const roofColor = m.color;
  const wall = new THREE.Color(spec.wall);
  const wallColor: V3 = dark ? [wall.r * RUIN_TINT, wall.g * RUIN_TINT, wall.b * RUIN_TINT] : [wall.r, wall.g, wall.b];
  const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, z0 = p.z - p.d / 2, z1 = p.z + p.d / 2, y = p.y, top = p.y + p.h;
  m.cur.aWin = [WIN_NONE, 0];
  switch (p.kind) {
    case 'gable': {
      const zm = p.z;
      m.face([[x0, y, z1], [x1, y, z1], [x1, top, zm], [x0, top, zm]], [0, 1, 1]);
      m.face([[x0, y, z0], [x1, y, z0], [x1, top, zm], [x0, top, zm]], [0, 1, -1]);
      m.color = wallColor;
      const ix0 = x0 + 0.4, ix1 = x1 - 0.4; // gable walls stand on the wall line, under the overhang
      m.face([[ix1, y, z0 + 0.4], [ix1, y, z1 - 0.4], [ix1, top - 0.1, zm]], [1, 0, 0]);
      m.face([[ix0, y, z0 + 0.4], [ix0, y, z1 - 0.4], [ix0, top - 0.1, zm]], [-1, 0, 0]);
      m.color = roofColor;
      break;
    }
    case 'hip': {
      const ridge = Math.max(0, p.w - p.d) / 2;
      const rx0 = p.x - ridge, rx1 = p.x + ridge;
      if (ridge > 0.01) {
        m.face([[x0, y, z1], [x1, y, z1], [rx1, top, p.z], [rx0, top, p.z]], [0, 1, 1]);
        m.face([[x0, y, z0], [x1, y, z0], [rx1, top, p.z], [rx0, top, p.z]], [0, 1, -1]);
      } else {
        m.face([[x0, y, z1], [x1, y, z1], [p.x, top, p.z]], [0, 1, 1]);
        m.face([[x0, y, z0], [x1, y, z0], [p.x, top, p.z]], [0, 1, -1]);
      }
      m.face([[x1, y, z0], [x1, y, z1], [rx1, top, p.z]], [1, 1, 0]);
      m.face([[x0, y, z0], [x0, y, z1], [rx0, top, p.z]], [-1, 1, 0]);
      break;
    }
    case 'shed': {
      // High at the back, low at the front; double sided (awnings are seen from below).
      m.face([[x0, top, z0], [x1, top, z0], [x1, y, z1], [x0, y, z1]], [0, 1, 1]);
      m.face([[x0, top, z0], [x1, top, z0], [x1, y, z1], [x0, y, z1]], [0, -1, -1]);
      m.face([[x1, y, z0], [x1, top, z0], [x1, y, z1]], [1, 0, 0]);
      m.face([[x0, y, z0], [x0, top, z0], [x0, y, z1]], [-1, 0, 0]);
      break;
    }
    case 'saw': {
      const n = Math.max(2, Math.round(p.d / 6));
      const glass = new THREE.Color(0x40505a);
      for (let i = 0; i < n; i++) {
        const za = z0 + (i / n) * p.d, zb = z0 + ((i + 1) / n) * p.d;
        m.color = roofColor;
        m.cur.aWin = [WIN_NONE, 0];
        m.face([[x0, top, za], [x1, top, za], [x1, y, zb], [x0, y, zb]], [0, 1, 1]);
        m.face([[x1, y, za], [x1, top, za], [x1, y, zb]], [1, 0, 0]);
        m.face([[x0, y, za], [x0, top, za], [x0, y, zb]], [-1, 0, 0]);
        // Glazed north light (unlit: factory halls are dark at night).
        m.color = dark ? [0.02, 0.02, 0.02] : [glass.r, glass.g, glass.b];
        m.face([[x0, y, za], [x1, y, za], [x1, top, za], [x0, top, za]], [0, 0, -1]);
      }
      m.color = roofColor;
      break;
    }
  }
  m.cur.aWin = [WIN_NONE, 0];
}

/** Scattered debris boxes around / on the footprint (abandoned yards, rubble piles). */
function debris(m: MeshData, spec: BuildingSpec, rng: Rng, amount: number): void {
  const n = Math.round(Math.max(3, (spec.width * spec.depth) / 25) * amount);
  m.cur.aWin = [WIN_NONE, 0];
  for (let i = 0; i < n; i++) {
    // Along the front / back walls or along the side walls, just outside them.
    const out = (half: number) => (half + 0.4 + rng() * 1.6) * (rng() < 0.5 ? 1 : -1);
    const frontBack = rng() < 0.5;
    const x = frontBack ? (rng() - 0.5) * (spec.width + 3) : out(spec.width / 2);
    const z = frontBack ? out(spec.depth / 2) : (rng() - 0.5) * spec.depth;
    m.setColor(rng() < 0.5 ? spec.wall : 0x5c5852, 0.55 + rng() * 0.3);
    m.box(x, -0.2, z, 0.4 + rng() * 1.4, 0.3 + rng() * 0.7, 0.4 + rng() * 1.2, rng() * Math.PI);
  }
}

/** An unfinished building: what is built of each wall block, and the tower crane (same for both detail levels). */
interface SitePlan {
  blocks: { p: Part; levels: number; levelH: number; built: number; lastSlab: number; nx: number; nz: number; skip: boolean }[];
  /** Trolley position along the jib (share of its length) and hook height (local); cosmetic. */
  hook: { trolley: number; y: number };
}

/** Seeded plan of a construction site; every random draw happens here, so near and far geometry agree. */
function sitePlan(b: Building, spec: BuildingSpec): SitePlan {
  const rng = mulberry32(hash32(b.seed, 0xc0b5));
  const blocks = spec.parts.filter((p) => p.kind === 'block').map((p) => {
    const levels = Math.max(1, Math.round(p.h / (p.windows?.floorHeight ?? Math.min(p.h, 3.2))));
    // Built up to at least one storey; the slab on top is only partly poured.
    const built = Math.max(1, Math.ceil(levels * (0.4 + rng() * 0.6)));
    return {
      p, levels, levelH: p.h / levels, built, lastSlab: 0.35 + rng() * 0.65,
      nx: Math.max(1, Math.round(p.w / SITE_BAY)), nz: Math.max(1, Math.round(p.d / SITE_BAY)), skip: false,
    };
  });
  // A block resting on another one (tower on a podium, roof house) is only built once everything under it is finished
  // and its top slab fully poured; otherwise it would hang in the air.
  for (const c of blocks) {
    if (c.p.y < 0.01) continue;
    const under = blocks.filter((o) => o !== c && o.p.y < c.p.y && Math.abs(o.p.x - c.p.x) < (o.p.w + c.p.w) / 2 && Math.abs(o.p.z - c.p.z) < (o.p.d + c.p.d) / 2);
    c.skip = under.some((o) => o.skip || o.built < o.levels);
    if (!c.skip) for (const o of under) o.lastSlab = 1;
  }
  // The hook hangs a little over the frame of the tallest block (where the crane stands, see terrain/buildings/crane.ts).
  const main = blocks.filter((c) => !c.skip).reduce((a, c) => (c.p.y + c.p.h > a.p.y + a.p.h ? c : a));
  return { blocks, hook: { trolley: 0.35 + rng() * 0.5, y: main.p.y + main.built * main.levelH + 2 + rng() * 5 } };
}

/** Column grid spacing of a construction frame (m), and the colours of the site. */
const SITE_BAY = 5;
const CONCRETE = 0x9c9a94;
const CRANE = 0xe2a51c;
const BEACON_HOUSING = 0x7a1410;
/** Local heights above the mast top (`Crane.height`) of the crane's beacons: the jib tip and the apex top (see `buildCrane`). */
export const CRANE_JIB_BEACON = 1.4;
export const CRANE_APEX_BEACON = 5.4;

/**
 * Construction site: per wall block a bare concrete frame (columns on a SITE_BAY grid, floor slabs, the top slab only
 * partly poured), the tower crane if it has one (Building.crane). Near: every column, rebar on the top columns,
 * stacked materials. Far: slabs and the outer columns.
 */
function buildSite(m: MeshData, b: Building, spec: BuildingSpec, far: boolean): void {
  const { blocks, hook } = sitePlan(b, spec);
  for (const { p, levelH, built, lastSlab, nx, nz, skip } of blocks) {
    if (skip) continue;
    const x0 = p.x - p.w / 2, z0 = p.z - p.d / 2, col = 0.45;
    const columnAt = (i: number, k: number): [number, number] => [x0 + col / 2 + (i * (p.w - col)) / nx, z0 + col / 2 + (k * (p.d - col)) / nz];
    for (let f = 0; f <= built; f++) {
      const y = p.y + f * levelH;
      m.setColor(CONCRETE, f === built ? 1.08 : 0.95); // fresh concrete on top
      // Ground slab (on the pad, down into the ground), floor slabs, the last one poured from the back.
      if (f === 0) m.box(p.x, p.y - FOUNDATION, p.z, p.w, FOUNDATION + 0.25, p.d);
      else if (f < built) m.box(p.x, y - 0.25, p.z, p.w, 0.25, p.d, 0, true);
      else m.box(p.x, y - 0.25, z0 + (p.d * lastSlab) / 2, p.w, 0.25, p.d * lastSlab, 0, true);
      if (f === built) break;
      // Columns up to the next slab (far: the outer ones only).
      m.setColor(CONCRETE, 0.85);
      for (let i = 0; i <= nx; i++)
        for (let k = 0; k <= nz; k++) {
          if (far && i > 0 && i < nx && k > 0 && k < nz) continue;
          const [cx, cz] = columnAt(i, k);
          m.box(cx, y, cz, col, levelH - 0.25, col);
        }
    }
    if (!far) {
      // Rebar sticking out of the top columns, ready for the next storey.
      m.setColor(0x5a3e2b);
      const y = p.y + built * levelH;
      for (let i = 0; i <= nx; i++)
        for (let k = 0; k <= nz; k++) {
          const [cx, cz] = columnAt(i, k);
          if (cz > z0 + p.d * lastSlab + 0.3) continue; // only where the top slab is poured
          for (const [dx, dz] of [[-0.12, -0.12], [0.12, -0.12], [-0.12, 0.12], [0.12, 0.12]]) m.box(cx + dx, y, cz + dz, 0.05, 1.1, 0.05);
        }
    }
  }

  if (b.crane) buildCrane(m, b, b.crane, hook, far);
  if (!far) siteMaterials(m, b, blocks[0]);
}

/**
 * Tower crane (planned by the generator, world space; drawn in the building's local frame): foundation, mast, jib with
 * counter-jib and counterweight; near also the lattice, apex, cab, trolley, cable and hook.
 */
function buildCrane(m: MeshData, b: Building, crane: NonNullable<Building['crane']>, hook: SitePlan['hook'], far: boolean): void {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const wx = crane.x - b.x, wz = crane.z - b.z;
  const x = wx * c - wz * s, z = wx * s + wz * c;
  const dx = Math.sin(crane.heading - b.yaw), dz = Math.cos(crane.heading - b.yaw); // jib direction, local
  const angle = Math.atan2(-dz, dx); // box rotation whose local +X runs along the jib
  const { height: H, jib, counter } = crane;
  m.setColor(CONCRETE, 0.8);
  m.box(x, -0.5, z, 3.2, 1.0, 3.2);
  m.setColor(CRANE);
  const mast = 1.6;
  if (far) m.box(x, 0, z, mast, H, mast);
  else {
    // Lattice mast: four corner chords and a ring of braces every 2 m.
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.box(x + (sx * (mast - 0.16)) / 2, 0, z + (sz * (mast - 0.16)) / 2, 0.16, H, 0.16);
    for (let y = 2; y < H - 0.5; y += 2) {
      m.box(x, y, z - mast / 2 + 0.06, mast, 0.1, 0.1);
      m.box(x, y, z + mast / 2 - 0.06, mast, 0.1, 0.1);
      m.box(x - mast / 2 + 0.06, y, z, 0.1, 0.1, mast);
      m.box(x + mast / 2 - 0.06, y, z, 0.1, 0.1, mast);
    }
  }
  // Jib (forward) and counter-jib in one beam, over the mast top.
  const beam = jib + counter, mid = (jib - counter) / 2;
  m.box(x + dx * mid, H, z + dz * mid, beam, 1.1, 1.0, angle);
  // Counterweight under the counter-jib's end, cab below the jib on the mast.
  m.setColor(CONCRETE, 0.7);
  m.box(x - dx * counter * 0.8, H - 1.8, z - dz * counter * 0.8, 2.6, 1.8, 2.2, angle);
  // Beacon housings (dark red) at the jib tip and the apex top; the flashing light itself is a LightDef (layer.ts).
  m.setColor(BEACON_HOUSING);
  m.box(x + dx * jib, H + 1.1, z + dz * jib, 0.5, 0.5, 0.5, angle);
  if (far) return;
  m.setColor(CRANE, 0.85);
  m.box(x, H + 1.1, z, 0.9, 4, 0.9); // apex
  m.setColor(BEACON_HOUSING);
  m.box(x, H + 5.1, z, 0.5, 0.5, 0.5);
  m.setColor(0xd8d6cf);
  m.box(x + dx * 1.2, H - 2.2, z + dz * 1.2, 1.6, 2.2, 1.6, angle); // cab
  const t = hook.trolley * jib, hookY = Math.min(hook.y, H - 3);
  const tx = x + dx * t, tz = z + dz * t;
  m.setColor(0x333333);
  m.box(tx, H - 0.4, tz, 1.4, 0.4, 1.2, angle); // trolley
  m.box(tx, hookY + 0.7, tz, 0.06, H - 0.4 - (hookY + 0.7), 0.06); // cable
  m.setColor(CRANE, 0.9);
  m.box(tx, hookY, tz, 0.7, 0.7, 0.5); // hook block
}

/**
 * Stacked materials (timber, concrete parts) on the ground floor of the first block (near detail): at bay centres,
 * clear of the columns, inside the footprint, so they never reach a street or a neighbour.
 */
function siteMaterials(m: MeshData, b: Building, { p, nx, nz }: SitePlan['blocks'][number]): void {
  const stacks = mulberry32(hash32(b.seed, 0x5ac));
  const bayW = p.w / nx, bayD = p.d / nz;
  for (let n = 0; n < Math.min(4, nx * nz); n++) {
    const i = Math.floor(stacks() * nx), k = Math.floor(stacks() * nz);
    const cx = p.x - p.w / 2 + (i + 0.5) * bayW, cz = p.z - p.d / 2 + (k + 0.5) * bayD;
    m.setColor(stacks() < 0.5 ? 0x8a6a45 : CONCRETE, 0.8 + stacks() * 0.3);
    const w = Math.min(bayW - 1.2, 1.2 + stacks()), d = Math.min(bayD - 1.2, 1 + stacks() * 0.6);
    if (w > 0.3 && d > 0.3) m.box(cx, p.y + 0.25, cz, w, 0.4 + stacks() * 0.8, d);
  }
}

/** Debris pile over the footprint (the destroyed building), plus broken wall stumps on tall ones. */
export function buildRubble(m: MeshData, b: Building, spec: BuildingSpec, far: boolean): void {
  const rng = mulberry32(hash32(b.seed, 0x0bb1e));
  m.frame(b.x, b.y, b.z, b.yaw);
  m.cur.aWin = [WIN_NONE, 0];
  const w = spec.width * 0.95, d = spec.depth * 0.95;
  const pileH = Math.min(4, 0.6 + spec.height * 0.18);
  m.setColor(0x6d655b);
  m.box(0, -0.5, 0, w, 0.8, d);
  const count = far ? 3 : Math.min(36, Math.max(8, Math.round((w * d) / 10)));
  for (let i = 0; i < count; i++) {
    const u = (rng() - 0.5) * w * 0.85, v = (rng() - 0.5) * d * 0.85;
    const centre = 1 - Math.max(Math.abs(u) / (w / 2), Math.abs(v) / (d / 2));
    const h = pileH * (0.3 + 0.7 * centre) * (0.5 + rng() * 0.5);
    const size = far ? Math.min(w, d) * 0.5 : 1 + rng() * Math.min(5, Math.min(w, d) * 0.35);
    m.setColor(rng() < 0.55 ? spec.wall : rng() < 0.5 ? spec.roof : 0x55524d, 0.5 + rng() * 0.35);
    m.box(u, -0.3, v, size, h, size * (0.5 + rng()), rng() * Math.PI);
  }
  if (!far && spec.height > 7) {
    const stumps = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < stumps; i++) {
      const alongX = rng() < 0.5;
      const len = 2 + rng() * 4, h = 2 + rng() * spec.height * 0.35;
      const sx = rng() < 0.5 ? -1 : 1;
      m.setColor(spec.wall, 0.55);
      if (alongX) m.box((rng() - 0.5) * (w - len), -0.3, sx * (d / 2 - 0.3), len, h, 0.4);
      else m.box(sx * (w / 2 - 0.3), -0.3, (rng() - 0.5) * (d - len), 0.4, h, len);
    }
  }
}

/**
 * Far (simple) building: blocks as boxes whose walls carry the near level's exact window grid for the shader, roofs as
 * shapes, no details. Extras: aFacade = [u along the wall (m), height above the block base (m), floor height, column
 * spacing], aGrid = [sill, window height, window width, lit share], aCols = [first column centre, columns, wall + 4 *
 * block, floors], aDoor = [doors, door width, door height, wall length] (front wall of a ground block), aSeed = building
 * seed hash, aGlass = pane colour (linear).
 */
export function buildFar(m: MeshData, b: Building, spec: BuildingSpec = buildingSpec(b.seed, b.type)): void {
  m.frame(b.x, b.y, b.z, b.yaw);
  if (b.condition === 'construction') {
    for (const name of ['aFacade', 'aGrid', 'aCols', 'aDoor']) m.cur[name] = [0, 0, 0, 0];
    m.cur.aSeed = [0];
    buildSite(m, b, spec, true);
    return;
  }
  const ruin = ruinOf(b, spec);
  const tint = ruin ? RUIN_TINT : 1;
  const blocks = blockIndex(spec);
  m.cur.aSeed = [windowSeed(b)];
  for (const p of spec.parts) {
    if (p.detail || fallen(p, ruin)) continue;
    m.setColor(p.color, tint);
    const none = () => {
      m.cur.aFacade = [0, 0, 0, 0];
      m.cur.aGrid = [0, 0, 0, 0];
      m.cur.aCols = [0, 0, 0, 0];
      m.cur.aDoor = [0, 0, 0, 0];
    };
    none();
    if (p.kind === 'block') {
      const g = p.windows;
      const top = solidTopOf(p, p === ruin?.block);
      const y0 = p.y > 0.05 ? p.y : -FOUNDATION;
      walls(p).forEach((wall, wallIdx) => {
        const at = (u: number, y: number): V3 => [wall.o[0] + wall.dir[0] * u, y, wall.o[2] + wall.dir[2] * u];
        const cols = g && g.faces & wall.bit ? columns(wall.len, g) : [];
        const fac = (u: number, y: number) => ({ aFacade: [u, y - p.y, cols.length ? g!.floorHeight : 0, g?.spacing ?? 0] });
        if (cols.length) {
          m.cur.aGrid = [g!.sill, g!.height, g!.width, ruin ? 0 : spec.litShare];
          m.cur.aCols = [cols[0], cols.length, wallIdx + 4 * (blocks.get(p) ?? 0), floorsUnder(p, g!, top)];
          const d = p.doors;
          m.cur.aDoor = wall.bit === 1 && d && p.y <= 0.05 ? [d.count, d.width, d.height, wall.len] : [0, 0, 0, 0];
          const glass = new THREE.Color(ruin ? 0x141516 : g!.glass);
          m.cur.aGlass = [glass.r, glass.g, glass.b];
        }
        m.face([at(0, y0), at(wall.len, y0), at(wall.len, top), at(0, top)], wall.out, [fac(0, y0), fac(wall.len, y0), fac(wall.len, top), fac(0, top)]);
        none();
      });
      const hw = p.w / 2, hd = p.d / 2;
      // Top: roof deck, or the same charred floor as the near level inside a broken ruin.
      if (p === ruin?.block) m.color = [...RUIN_FLOOR];
      else m.setColor(p.color, tint * 0.7);
      m.face([[p.x - hw, top, p.z - hd], [p.x + hw, top, p.z - hd], [p.x + hw, top, p.z + hd], [p.x - hw, top, p.z + hd]], [0, 1, 0]);
    } else if (p.kind === 'slab') {
      m.box(p.x, p.y, p.z, p.w, p.h, p.d, 0, p.y > 0.05);
    } else if (p.kind === 'cylinder') {
      m.cylinder(p.x, p.y, p.z, p.w, p.h, 6);
    } else {
      roof(m, p, spec, !!ruin);
    }
  }
}

/**
 * A few windows (local position + window key) that carry the far-away light halos; the halo shader shows each one
 * only while its window is lit (same schedule as the panes). Empty for abandoned buildings and construction sites.
 */
export function haloSpots(b: Building, spec: BuildingSpec = buildingSpec(b.seed, b.type)): { pos: V3; key: V3 }[] {
  if (b.condition !== 'intact' || spec.litShare <= 0) return [];
  const rng = mulberry32(hash32(b.seed, 0x4a10));
  const blocks = [...blockIndex(spec)];
  if (!blocks.length) return [];
  const out: { pos: V3; key: V3 }[] = [];
  const count = Math.min(6, 2 + Math.floor(spec.floors / 2));
  for (let i = 0; i < count * 3 && out.length < count; i++) {
    const [p, block] = blocks[Math.floor(rng() * blocks.length)];
    const g = p.windows!;
    const faces = walls(p).map((w, idx) => ({ w, idx })).filter(({ w }) => g.faces & w.bit);
    const { w: wall, idx } = faces[Math.floor(rng() * faces.length)];
    const cols = columns(wall.len, g);
    if (!cols.length) continue;
    const col = Math.floor(rng() * cols.length);
    const f = Math.floor(rng() * g.floors);
    if (f === 0 && wall.bit === 1 && doorBlocks(p, g, wall.len, cols[col])) continue;
    const y = p.y + f * g.floorHeight + g.sill + g.height / 2;
    const u = cols[col];
    out.push({ pos: [wall.o[0] + wall.dir[0] * u + wall.out[0] * 0.5, y, wall.o[2] + wall.dir[2] * u + wall.out[2] * 0.5], key: [col, f, idx + 4 * block] });
  }
  return out;
}

/** Window floors (from the ground) whose lit windows are mirrored by wet ground; higher ones are left out (cost). */
const REFLECT_FLOORS = 3;

/** A lit window or sign mirrored by wet ground (reflect.vert.glsl, WINDOW): local centre, outward normal, half width. */
export interface GlowSpot {
  pos: V3;
  out: V3;
  halfWidth: number;
  /** Window key (column, floor, wall + 4 * block); null for a sign (always lit, `color`). */
  key: V3 | null;
  /** Sign colour (sRGB hex). */
  color: number;
}

/**
 * Every window of the lowest REFLECT_FLOORS floors (the shader keeps the lit ones) plus the lit signs on walls / pylons
 * (thin glowing slabs; the gas canopy's underside is a LightDef). Empty for abandoned buildings and construction sites.
 */
export function glowSpots(b: Building, spec: BuildingSpec = buildingSpec(b.seed, b.type)): GlowSpot[] {
  if (b.condition !== 'intact') return [];
  const out: GlowSpot[] = [];
  if (spec.litShare > 0) {
    for (const [p, block] of blockIndex(spec)) {
      const g = p.windows!;
      walls(p).forEach((wall, idx) => {
        if (!(g.faces & wall.bit)) return;
        const floors = Math.min(REFLECT_FLOORS, floorsUnder(p, g, p.y + p.h));
        columns(wall.len, g).forEach((u, col) => {
          for (let f = 0; f < floors; f++) {
            if (f === 0 && wall.bit === 1 && doorBlocks(p, g, wall.len, u)) continue;
            const y = p.y + f * g.floorHeight + g.sill + g.height / 2;
            const pos: V3 = [wall.o[0] + wall.dir[0] * u + wall.out[0] * 0.1, y, wall.o[2] + wall.dir[2] * u + wall.out[2] * 0.1];
            out.push({ pos, out: wall.out, halfWidth: g.width * 0.4, key: [col, f, idx + 4 * block], color: 0 });
          }
        });
      });
    }
  }
  for (const p of spec.parts) {
    if (!p.glow || p.kind !== 'slab' || p.h < 0.3) continue;
    out.push({ pos: [p.x, p.y + p.h / 2, p.z + p.d / 2 + 0.05], out: [0, 0, 1], halfWidth: p.w * 0.4, key: null, color: p.color });
  }
  return out;
}

/** World position of a local building point. */
export function toWorld(b: Building, [x, y, z]: V3): V3 {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return [b.x + x * c + z * s, b.y + y, b.z - x * s + z * c];
}
