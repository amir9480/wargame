// Wet-surface mask for light reflections (reflect.frag.glsl): a world-space R8 texture over the whole grid saying how
// mirror-like the ground is: asphalt carriageways, car parks and gas station forecourts 1, town sidewalks (same ribbon,
// see roads.ts) and paved town yards a bit less, everything else (dirt, rail, grass) 0. Rasterised on the CPU from the
// road graph and the ground decals (urban.ts groundPatches) once per map; no rng.

import * as THREE from 'three';
import type { Terrain } from '../terrain/generate.ts';
import { CURB_GAP, SIDEWALK_WIDTH, townAt } from '../terrain/urban.ts';
import { DECAL_PAVING, groundPatches } from './urban.ts';

/** Mask texel size, world units. */
const TEXEL = 0.5;
const CARRIAGEWAY = 255;
const SIDEWALK = 190;

export function buildWetMask(t: Pick<Terrain, 'worldSize' | 'roads' | 'cities' | 'buildings' | 'parking'>): THREE.DataTexture {
  const n = Math.ceil(t.worldSize / TEXEL);
  const data = new Uint8Array(n * n);
  const half = t.worldSize / 2;

  /** Capsule from a to b with radius r, value v (max-combined). */
  const stamp = (ax: number, az: number, bx: number, bz: number, r: number, v: number) => {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + half) / TEXEL));
    const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + r + half) / TEXEL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r + half) / TEXEL));
    const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + r + half) / TEXEL));
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * TEXEL - half;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * TEXEL - half;
        const s = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        const ex = x - ax - dx * s, ez = z - az - dz * s;
        if (ex * ex + ez * ez <= r * r) {
          const k = j * n + i;
          if (data[k] < v) data[k] = v;
        }
      }
    }
  };

  const walk = CURB_GAP + SIDEWALK_WIDTH;
  const nodeRadius = new Map<number, number>();
  for (const e of t.roads.edges) {
    if (e.type !== 'asphalt') continue;
    const hw = e.width / 2;
    for (let i = 0; i + 1 < e.points.length; i++) {
      const p = e.points[i], q = e.points[i + 1];
      const bridge = e.bridges.some((br) => i >= br.start - 1 && i <= br.end + 1);
      if (!bridge && townAt(t.cities, p.x, p.z) >= 0) stamp(p.x, p.z, q.x, q.z, hw + walk, SIDEWALK);
      stamp(p.x, p.z, q.x, q.z, hw, CARRIAGEWAY);
    }
    for (const id of [e.from, e.to]) nodeRadius.set(id, Math.max(nodeRadius.get(id) ?? 0, hw));
  }
  // Junctions: a disc of the widest road (plus sidewalks in towns), so plates / corners are covered too.
  for (const [id, r] of nodeRadius) {
    const node = t.roads.nodes[id];
    if (townAt(t.cities, node.x, node.z) >= 0) stamp(node.x, node.z, node.x, node.z, r + walk, SIDEWALK);
    stamp(node.x, node.z, node.x, node.z, r, CARRIAGEWAY);
  }

  // Ground decals: rectangles in their footprint frame (local +Z = (sin yaw, cos yaw)).
  for (const p of groundPatches(t)) {
    const { x: fx, z: fz, yaw } = p.frame;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const v = p.kind === DECAL_PAVING ? SIDEWALK : CARRIAGEWAY;
    const r = Math.max(Math.abs(p.u0), Math.abs(p.u1)) + Math.max(Math.abs(p.v0), Math.abs(p.v1));
    const i0 = Math.max(0, Math.floor((fx - r + half) / TEXEL)), i1 = Math.min(n - 1, Math.ceil((fx + r + half) / TEXEL));
    const j0 = Math.max(0, Math.floor((fz - r + half) / TEXEL)), j1 = Math.min(n - 1, Math.ceil((fz + r + half) / TEXEL));
    for (let j = j0; j <= j1; j++) {
      const dz = (j + 0.5) * TEXEL - half - fz;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * TEXEL - half - fx;
        const u = dx * c - dz * s, w = dx * s + dz * c;
        if (u < p.u0 || u > p.u1 || w < p.v0 || w > p.v1) continue;
        const k = j * n + i;
        if (data[k] < v) data[k] = v;
      }
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
