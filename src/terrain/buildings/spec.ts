// Building generator: one integer seed + a type -> the exact same building (size, floors, roof, colours, details)
// every time, on every machine. Pure data (no Three.js): the generator uses the footprint to place it, the
// renderer turns the parts into meshes (render/buildings/).
//
// Local frame: X along the building's width (parallel to its road), Z towards its front (the road), Y up;
// origin at the footprint centre on the ground. Parts are simple solids the renderer knows how to draw.

import { mulberry32, type Rng } from '../../core/rng.ts';
import type { BuildingType } from './types.ts';

/**
 * - block:    walls with a flat top (the body of a building); may carry a window grid and doors
 * - gable:    pitched roof, ridge along X
 * - hip:      roof sloping on all four sides (ridge along X when wider than deep)
 * - shed:     single slope, high at the back (-Z), low at the front (+Z); also awnings
 * - saw:      sawtooth roof: teeth along Z, glazed steep faces towards -Z
 * - slab:     plain box (parapets, canopies, balconies, pumps, chimneys, signs...)
 * - cylinder: upright cylinder of diameter w (tanks, silos, smoke stacks)
 */
export type PartKind = 'block' | 'gable' | 'hip' | 'shed' | 'saw' | 'slab' | 'cylinder';

export interface WindowGrid {
  /** Rows (one per floor) and their spacing. */
  floors: number;
  floorHeight: number;
  /** Bottom of a window above its floor. */
  sill: number;
  width: number;
  height: number;
  /** Distance between window centres along a wall. */
  spacing: number;
  /** Walls with windows: bit 1 front (+Z), 2 back (-Z), 4 right (+X), 8 left (-X). */
  faces: number;
  glass: number;
}

export interface DoorSet {
  /** Doors spread evenly over the front (+Z) wall. */
  count: number;
  width: number;
  height: number;
  color: number;
}

export interface Part {
  kind: PartKind;
  /** Centre of the bottom face in the local frame. */
  x: number;
  y: number;
  z: number;
  /** Size along X, Y, Z (a roof's h is its rise above y). */
  w: number;
  h: number;
  d: number;
  /** 0xRRGGBB (sRGB). */
  color: number;
  windows?: WindowGrid;
  doors?: DoorSet;
  /** Emissive at night (canopy lights, lit signs). */
  glow?: boolean;
  /** Detail only: left out of the far (simple) level of detail. */
  detail?: boolean;
}

/** Light the building casts at night (local frame), e.g. under a gas station canopy. */
export interface BuildingLight {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: number;
}

export interface BuildingSpec {
  seed: number;
  type: BuildingType;
  /** Footprint along X / Z (all parts, centred on the origin) and height of the highest part, metres. */
  width: number;
  depth: number;
  height: number;
  floors: number;
  /** Share of windows lit at night. */
  litShare: number;
  /** Main wall and roof colours (rubble, far level of detail). */
  wall: number;
  roof: number;
  parts: Part[];
  lights: BuildingLight[];
}

/** The building for (seed, type): same arguments, same building. */
export function buildingSpec(seed: number, type: BuildingType): BuildingSpec {
  const r = new Rand(mulberry32(seed >>> 0));
  const b = new Builder(seed >>> 0, type);
  MAKERS[type](r, b);
  return b.finish();
}

class Rand {
  readonly next: Rng;
  constructor(next: Rng) {
    this.next = next;
  }
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
}

class Builder {
  parts: Part[] = [];
  lights: BuildingLight[] = [];
  floors = 1;
  litShare = 0.5;
  wall = 0x999999;
  roof = 0x555555;
  readonly seed: number;
  readonly type: BuildingType;
  constructor(seed: number, type: BuildingType) {
    this.seed = seed;
    this.type = type;
  }

  add(kind: PartKind, x: number, y: number, z: number, w: number, h: number, d: number, color: number, extra: Partial<Part> = {}): Part {
    const p: Part = { kind, x, y, z, w, h, d, color, ...extra };
    this.parts.push(p);
    return p;
  }

  /** Thin wall rim around the top of a flat roof. */
  parapet(cx: number, top: number, cz: number, w: number, d: number, h: number, color: number): void {
    const t = 0.3;
    this.add('slab', cx, top, cz + d / 2 - t / 2, w, h, t, color);
    this.add('slab', cx, top, cz - d / 2 + t / 2, w, h, t, color);
    this.add('slab', cx + w / 2 - t / 2, top, cz, t, h, d - 2 * t, color);
    this.add('slab', cx - w / 2 + t / 2, top, cz, t, h, d - 2 * t, color);
  }

  /** Recentres the parts on the footprint and measures it. */
  finish(): BuildingSpec {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
    for (const p of this.parts) {
      x0 = Math.min(x0, p.x - p.w / 2);
      x1 = Math.max(x1, p.x + p.w / 2);
      z0 = Math.min(z0, p.z - p.d / 2);
      z1 = Math.max(z1, p.z + p.d / 2);
      top = Math.max(top, p.y + p.h);
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    for (const p of this.parts) {
      p.x -= cx;
      p.z -= cz;
    }
    for (const l of this.lights) {
      l.x -= cx;
      l.z -= cz;
    }
    return {
      seed: this.seed,
      type: this.type,
      width: x1 - x0,
      depth: z1 - z0,
      height: top,
      floors: this.floors,
      litShare: this.litShare,
      wall: this.wall,
      roof: this.roof,
      parts: this.parts,
      lights: this.lights,
    };
  }
}

/** HSL (all 0..1) to 0xRRGGBB. */
export function hsl(h: number, s: number, l: number): number {
  h = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** Colour scaled towards black (f < 1) or white (f > 1). */
export function shade(c: number, f: number): number {
  const ch = (v: number) => Math.round(Math.max(0, Math.min(255, f <= 1 ? v * f : v + (255 - v) * (f - 1))));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}

/**
 * Roof decks sit inside their parapet rim: equal outlines would put the deck's sides in the same planes as the
 * parapet's outer faces (z-fighting).
 */
const ROOF_INSET = 0.62;

const GLASS = [hsl(0.58, 0.35, 0.32), hsl(0.52, 0.3, 0.3), hsl(0.6, 0.15, 0.22), hsl(0.1, 0.25, 0.28)];
const WOOD_DOOR = [hsl(0.07, 0.45, 0.25), hsl(0.06, 0.3, 0.18), hsl(0.6, 0.1, 0.25), hsl(0.33, 0.25, 0.22)];
const TILE_ROOFS = [hsl(0.03, 0.55, 0.4), hsl(0.05, 0.4, 0.3), hsl(0.6, 0.12, 0.3), hsl(0, 0, 0.24), hsl(0.38, 0.22, 0.28), hsl(0.57, 0.2, 0.34)];

type Maker = (r: Rand, b: Builder) => void;

const MAKERS: Record<BuildingType, Maker> = {
  /** Family house: pastel walls (seeded hue), pitched or hipped tiled roof, maybe garage, porch, chimney. */
  villa(r, b) {
    const floors = r.chance(0.55) ? 2 : 1;
    const fh = r.range(2.9, 3.2);
    const w = r.range(9, 13), d = r.range(8, 11);
    const wall = r.chance(0.25) ? hsl(r.next(), 0.08, r.range(0.84, 0.92)) : hsl(r.next(), r.range(0.22, 0.55), r.range(0.66, 0.84));
    const roof = shade(r.pick(TILE_ROOFS), r.range(0.85, 1.15));
    const trim = r.chance(0.5) ? hsl(0.1, 0.1, 0.92) : shade(wall, 0.7);
    const h = floors * fh;
    b.floors = floors;
    b.litShare = r.range(0.45, 0.75);
    b.wall = wall;
    b.roof = roof;
    b.add('block', 0, 0, 0, w, h, d, wall, {
      windows: { floors, floorHeight: fh, sill: 0.9, width: 1.2, height: 1.4, spacing: r.range(2.4, 3), faces: 15, glass: r.pick(GLASS) },
      doors: { count: 1, width: 1.1, height: 2.2, color: r.pick(WOOD_DOOR) },
    });
    b.add('slab', 0, h - 0.27, 0, w + 0.2, 0.25, d + 0.2, trim, { detail: true }); // eaves band, just under the roof line
    const style = r.next();
    if (style < 0.15) {
      // Modern flat roof.
      b.add('slab', 0, h, 0, w - ROOF_INSET, 0.2, d - ROOF_INSET, shade(roof, 0.8));
      b.parapet(0, h, 0, w, d, 0.6, trim);
    } else if (style < 0.6) {
      b.add('gable', 0, h, 0, w + 0.8, r.range(1.8, 2.8), d + 0.8, roof);
    } else {
      b.add('hip', 0, h, 0, w + 0.8, r.range(1.6, 2.4), d + 0.8, roof);
    }
    if (r.chance(0.35)) {
      // Garage wing on one side.
      const gw = r.range(3.5, 4.5), gd = Math.min(d, 6.5), side = r.chance(0.5) ? 1 : -1;
      const gx = side * (w / 2 + gw / 2), gz = d / 2 - gd / 2;
      b.add('block', gx, 0, gz, gw, 2.8, gd, wall, { doors: { count: 1, width: gw - 1, height: 2.3, color: shade(trim, 0.85) } });
      b.add('slab', gx, 2.8, gz, gw + 0.2, 0.25, gd + 0.2, shade(roof, 0.75));
    }
    if (style >= 0.15 && r.chance(0.55)) b.add('slab', r.range(-w / 4, w / 4), h, -d * 0.15, 0.7, r.range(2.6, 3.4), 0.7, shade(wall, 0.6), { detail: true });
    if (r.chance(0.45)) {
      // Porch roof on two posts over the door.
      b.add('slab', 0, 2.5, d / 2 + 0.8, 2.6, 0.15, 1.6, trim, { detail: true });
      for (const s of [-1, 1]) b.add('slab', s * 1.15, 0, d / 2 + 1.45, 0.15, 2.5, 0.15, trim, { detail: true });
    }
  },

  /** Concrete block of flats: 3-6 floors, balconies, flat roof with parapet, stair house and water tanks. */
  apartment(r, b) {
    const floors = r.int(3, 6);
    const fh = 3;
    const w = r.range(14, 24), d = r.range(10, 14);
    const wall = hsl(r.next(), r.range(0.05, 0.25), r.range(0.55, 0.8));
    const trim = r.chance(0.5) ? shade(wall, 0.75) : hsl(0, 0, r.range(0.75, 0.88));
    const h = floors * fh;
    const spacing = r.range(2.8, 3.3);
    b.floors = floors;
    b.litShare = r.range(0.35, 0.7);
    b.wall = wall;
    b.roof = hsl(0, 0, 0.35);
    b.add('block', 0, 0, 0, w, h, d, wall, {
      windows: { floors, floorHeight: fh, sill: 0.9, width: 1.4, height: 1.5, spacing, faces: 15, glass: r.pick(GLASS) },
      doors: { count: w > 19 ? 2 : 1, width: 1.6, height: 2.4, color: shade(trim, 0.5) },
    });
    b.add('slab', 0, 0, 0, w + 0.15, 0.9, d + 0.15, shade(wall, 0.65), { detail: true }); // plinth
    b.add('slab', 0, h, 0, w - ROOF_INSET, 0.2, d - ROOF_INSET, hsl(0, 0, 0.35));
    b.parapet(0, h, 0, w, d, 0.8, trim);
    if (r.chance(0.65)) {
      // Balconies on the front every other window column, every floor above the ground floor.
      const cols = Math.max(1, Math.floor(w / spacing));
      const rail = r.chance(0.5) ? trim : hsl(0, 0, 0.3);
      for (let c = 1; c < cols; c += 2) {
        const x = -w / 2 + (c + 0.5) * (w / cols);
        for (let f = 1; f < floors; f++) {
          b.add('slab', x, f * fh - 0.1, d / 2 + 0.6, 2.3, 0.15, 1.2, trim, { detail: true });
          b.add('slab', x, f * fh + 0.05, d / 2 + 1.17, 2.3, 0.95, 0.06, rail, { detail: true });
        }
      }
    }
    b.add('block', r.range(-w / 4, w / 4), h, r.range(-d / 5, d / 5), 3, 2.6, 2.6, wall);
    const tanks = r.int(0, 2);
    for (let t = 0; t < tanks; t++) b.add('cylinder', r.range(-w / 2 + 1.5, w / 2 - 1.5), h + 0.2, r.range(-d / 2 + 1.5, -0.5), 1.3, 1.4, 1.3, hsl(0, 0, 0.7), { detail: true });
  },

  /** Office tower: glass bands over 6-12 floors, maybe a shop podium, roof crown and mast. */
  office(r, b) {
    const floors = r.int(6, 12);
    const fh = 3.5;
    const w = r.range(14, 20), d = w * r.range(0.75, 1);
    const frame = r.chance(0.5) ? hsl(0, 0, r.range(0.6, 0.82)) : hsl(r.next(), 0.1, r.range(0.25, 0.4));
    const glass = r.pick(GLASS);
    b.litShare = r.range(0.3, 0.8);
    b.wall = frame;
    b.roof = hsl(0, 0, 0.32);
    let base = 0;
    let total = floors;
    if (r.chance(0.4)) {
      const ph = 4.5;
      b.add('block', 0, 0, 0, w + 4, ph, d + 4, shade(frame, 0.9), {
        windows: { floors: 1, floorHeight: ph, sill: 0.4, width: 3, height: 3, spacing: 3.6, faces: 15, glass },
        doors: { count: 2, width: 2, height: 2.8, color: glass },
      });
      b.add('slab', 0, ph, 0, w + 4, 0.3, d + 4, hsl(0, 0, 0.35));
      base = ph;
      total++;
    }
    b.floors = total;
    const h = base + floors * fh;
    b.add('block', 0, base, 0, w, floors * fh, d, frame, {
      windows: { floors, floorHeight: fh, sill: 0.5, width: 1.9, height: 2.5, spacing: 2.1, faces: 15, glass },
      doors: base ? undefined : { count: 1, width: 2.4, height: 2.8, color: glass },
    });
    b.add('slab', 0, h, 0, w + 0.4, 0.7, d + 0.4, shade(frame, 0.85));
    b.add('block', 0, h + 0.7, 0, w * 0.4, 3, d * 0.4, shade(frame, 0.8));
    if (r.chance(0.5)) b.add('slab', w * 0.1, h + 3.7, 0, 0.2, r.range(4, 9), 0.2, hsl(0, 0, 0.3), { detail: true });
  },

  /** Market hall / shops: one high storey, shop windows, striped awnings, lit sign, roof units. */
  market(r, b) {
    const w = r.range(16, 30), d = r.range(12, 20), h = r.range(4.5, 5.5);
    const wall = hsl(r.next(), r.range(0.1, 0.4), r.range(0.55, 0.8));
    const glass = r.pick(GLASS);
    b.litShare = r.range(0.7, 1);
    b.wall = wall;
    b.roof = hsl(0, 0, 0.38);
    b.add('block', 0, 0, 0, w, h, d, wall, {
      windows: { floors: 1, floorHeight: h, sill: 0.5, width: 2.8, height: 2.6, spacing: 3.6, faces: 1, glass },
      doors: { count: Math.max(1, Math.floor(w / 10)), width: 2, height: 2.6, color: glass },
    });
    b.add('slab', 0, h, 0, w - ROOF_INSET, 0.2, d - ROOF_INSET, hsl(0, 0, 0.38));
    b.parapet(0, h, 0, w, d, 0.7, shade(wall, 0.8));
    b.add('slab', 0, h, d / 2 - 0.13, w + 0.06, 1.4, 0.32, shade(wall, 0.85)); // taller front parapet, proud of the rim
    b.add('slab', 0, h + 0.3, d / 2 + 0.05, w * r.range(0.35, 0.6), 0.9, 0.2, hsl(r.next(), 0.8, 0.55), { glow: true });
    if (r.chance(0.75)) {
      const a = hsl(r.next(), 0.7, 0.45), c = r.chance(0.5) ? hsl(0, 0, 0.92) : hsl(r.next(), 0.6, 0.5);
      const n = Math.max(2, Math.floor(w / 4));
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + (i + 0.5) * (w / n);
        b.add('shed', x, 2.9, d / 2 + 0.9, w / n - 0.15, 0.6, 1.8, i % 2 ? c : a, { detail: true });
      }
    }
    const units = r.int(1, 4);
    for (let u = 0; u < units; u++) b.add('slab', r.range(-w / 2 + 2, w / 2 - 2), h + 0.2, r.range(-d / 2 + 2, d / 2 - 3), 1.6, 1, 1.4, hsl(0, 0, 0.62), { detail: true });
  },

  /** Gas station: brand-coloured canopy on columns over the pump islands, kiosk behind, price pylon. */
  gas(r, b) {
    const W = r.range(16, 22), D = r.range(14, 18);
    const brand = hsl(r.pick([0, 0.02, 0.33, 0.6, 0.13, 0.08]), r.range(0.65, 0.85), r.range(0.4, 0.5));
    const white = hsl(0, 0, 0.92);
    b.litShare = 1;
    b.wall = white;
    b.roof = brand;
    // Canopy over the front half.
    const cw = W * 0.8, cd = D * 0.5, cz = D / 2 - cd / 2, ch = 4.8;
    b.add('slab', 0, ch, cz, cw, 0.9, cd, brand);
    b.add('slab', 0, ch - 0.04, cz, cw - 0.6, 0.06, cd - 0.6, hsl(0.12, 0.3, 0.95), { glow: true });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('slab', sx * cw * 0.3, 0, cz + sz * cd * 0.22, 0.4, ch, 0.4, hsl(0, 0, 0.75));
    const islands = r.int(2, 3);
    for (let i = 0; i < islands; i++) {
      const x = -cw / 2 + (i + 0.5) * (cw / islands);
      b.add('slab', x, 0, cz, 1, 0.2, 3.2, hsl(0, 0, 0.6), { detail: true });
      for (const s of [-1, 1]) b.add('slab', x, 0.2, cz + s * 0.8, 0.6, 1.7, 0.45, s > 0 ? white : brand, { detail: true });
    }
    b.lights.push({ x: 0, y: ch - 0.1, z: cz, radius: 14, color: 0xfff0d8 });
    // Kiosk at the back.
    const kw = r.range(7, 10), kd = r.range(5, 7), kh = 3.6, kx = r.range(-W / 2 + kw / 2, W / 2 - kw / 2), kz = -D / 2 + kd / 2;
    b.add('block', kx, 0, kz, kw, kh, kd, white, {
      windows: { floors: 1, floorHeight: kh, sill: 0.5, width: 2.4, height: 2.2, spacing: 3, faces: 1, glass: r.pick(GLASS) },
      doors: { count: 1, width: 1.6, height: 2.3, color: hsl(0.58, 0.2, 0.3) },
    });
    b.add('slab', kx, kh, kz, kw + 0.3, 0.5, kd + 0.3, brand);
    // Price pylon at a front corner.
    const px = (r.chance(0.5) ? 1 : -1) * (W / 2 - 0.6);
    b.add('slab', px, 0, D / 2 - 0.4, 0.4, 4, 0.3, hsl(0, 0, 0.4));
    b.add('slab', px, 4, D / 2 - 0.4, 2, 2, 0.4, brand, { glow: true });
  },

  /** Warehouse / factory hall: corrugated walls, loading doors, low gable or sawtooth roof, maybe a smoke stack. */
  warehouse(r, b) {
    const w = r.range(20, 40), d = r.range(14, 24), h = r.range(6, 9);
    const factory = r.chance(0.4);
    const wall = shade(r.pick([hsl(0.58, 0.05, 0.6), hsl(0.6, 0.3, 0.45), hsl(0.4, 0.2, 0.42), hsl(0.03, 0.45, 0.38), hsl(0.12, 0.25, 0.72)]), r.range(0.9, 1.1));
    const roof = r.pick([hsl(0, 0, 0.42), hsl(0.58, 0.1, 0.35), hsl(0.05, 0.35, 0.33)]);
    b.litShare = r.range(0.2, 0.5);
    b.wall = wall;
    b.roof = roof;
    b.add('block', 0, 0, 0, w, h, d, wall, {
      windows: { floors: 1, floorHeight: h, sill: h - 2.2, width: 2.8, height: 1, spacing: 4.2, faces: 15, glass: hsl(0.55, 0.15, 0.35) },
      doors: { count: Math.max(1, Math.floor(w / 9)), width: 3.6, height: Math.min(4.4, h - 1.5), color: shade(wall, 0.55) },
    });
    if (factory) b.add('saw', 0, h, 0, w, 2.2, d, roof);
    else b.add('gable', 0, h, 0, w + 0.6, r.range(1.2, 2.2), d + 0.6, roof);
    if (factory) {
      // Office annex at one end and a smoke stack at the back.
      const side = r.chance(0.5) ? 1 : -1;
      b.add('block', side * (w / 2 + 3), 0, d / 2 - 4, 6, 6, 8, hsl(0, 0, 0.78), {
        windows: { floors: 2, floorHeight: 3, sill: 0.9, width: 1.4, height: 1.4, spacing: 2.4, faces: 15, glass: r.pick(GLASS) },
        doors: { count: 1, width: 1.4, height: 2.3, color: hsl(0.6, 0.2, 0.3) },
      });
      b.add('slab', side * (w / 2 + 3), 6, d / 2 - 4, 6.2, 0.3, 8.2, hsl(0, 0, 0.4));
      b.add('cylinder', -side * (w / 2 - 2.5), 0, -d / 2 + 2.5, r.range(1.6, 2.4), r.range(16, 24), r.range(1.6, 2.4), hsl(0.03, 0.4, 0.35));
    }
    b.floors = factory ? 2 : 1;
  },

  /** Farmhouse: small, steep gable roof, white / stone walls, chimney. */
  farmhouse(r, b) {
    const floors = r.chance(0.5) ? 2 : 1;
    const fh = 2.8;
    const w = r.range(8, 11), d = r.range(7, 9);
    const wall = r.pick([hsl(0.12, 0.2, 0.86), hsl(0.1, 0.15, 0.7), hsl(0.08, 0.12, 0.6), hsl(0.14, 0.35, 0.78)]);
    const roof = r.pick([hsl(0.02, 0.5, 0.36), hsl(0, 0, 0.26), hsl(0.07, 0.35, 0.28)]);
    const h = floors * fh;
    b.floors = floors;
    b.litShare = r.range(0.5, 0.8);
    b.wall = wall;
    b.roof = roof;
    b.add('block', 0, 0, 0, w, h, d, wall, {
      windows: { floors, floorHeight: fh, sill: 0.9, width: 1, height: 1.2, spacing: r.range(2.4, 3), faces: 15, glass: GLASS[2] },
      doors: { count: 1, width: 1.1, height: 2.1, color: r.pick(WOOD_DOOR) },
    });
    b.add('gable', 0, h, 0, w + 0.8, r.range(2.6, 3.6), d + 0.8, roof);
    b.add('slab', w * r.range(-0.3, 0.3), h, -d * 0.1, 0.8, 3.6, 0.8, shade(wall, 0.65), { detail: true });
  },

  /** Barn: wooden walls, big front door, tall gable roof, maybe a silo. */
  barn(r, b) {
    const w = r.range(10, 14), d = r.range(7, 10), h = r.range(3.8, 4.8);
    const wall = r.pick([hsl(0, 0.55, 0.33), hsl(0.07, 0.4, 0.3), hsl(0, 0, 0.45), hsl(0.3, 0.18, 0.33)]);
    const roof = r.pick([hsl(0, 0, 0.3), hsl(0.05, 0.4, 0.3), hsl(0.58, 0.08, 0.4)]);
    b.litShare = r.range(0.1, 0.3);
    b.wall = wall;
    b.roof = roof;
    b.add('block', 0, 0, 0, w, h, d, wall, {
      windows: { floors: 1, floorHeight: h, sill: 2.6, width: 0.9, height: 0.8, spacing: 4.5, faces: 12, glass: GLASS[2] },
      doors: { count: 1, width: 3.6, height: Math.min(3.4, h - 0.4), color: shade(wall, 0.6) },
    });
    b.add('gable', 0, h, 0, w + 0.6, r.range(3, 4), d + 0.6, roof);
    if (r.chance(0.3)) {
      const sr = r.range(3.2, 4.2);
      b.add('cylinder', (r.chance(0.5) ? 1 : -1) * (w / 2 + sr / 2 + 0.5), 0, -d / 2 + sr / 2, sr, r.range(9, 12), sr, hsl(0, 0, 0.68));
    }
  },
};
