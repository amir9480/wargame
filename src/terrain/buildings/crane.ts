// Tower cranes over construction sites, planned from the placed (and levelled) buildings. Pure: hashes of the building
// seeds, no random stream, so adding cranes changed nothing else on the map.
//
// A crane stands in its site's tallest block; its jib + counter-jib beam is one straight line at the mast top. Of 16
// headings (seeded start) the one needing the lowest mast wins, where a heading needs the beam to clear
//   - the ground under it by GROUND_CLEAR (trees, street lights, traffic lights are all lower),
//   - every other building it passes over by BUILDING_CLEAR,
//   - every crane planned before it: a beam crossing another one runs CRANE_CLEAR above it; passing over another
//     mast, or putting this mast under another beam, rules the heading out.
// The mast is never lower than the site's full planned height + TOP_CLEAR.

import { hash32 } from '../../core/rng.ts';
import { sampleGrid } from '../grid.ts';
import { buildingSpec } from './spec.ts';
import type { Building, Crane } from './types.ts';

/** Share of construction sites with a crane. */
export const CRANE_SHARE = 0.3;
const GROUND_CLEAR = 13;
const BUILDING_CLEAR = 3;
const CRANE_CLEAR = 3;
const TOP_CLEAR = 6;
/** Plan distance (m) within which a beam counts as hitting a mast. */
const MAST_REACH = 3;
const HEADINGS = 16;
/** Beam sample spacing (m). */
const STEP = 2;

interface Ground {
  heights: Float32Array;
  N: number;
  cell: number;
}

/** Sets `crane` on every construction site that gets one (in id order), null elsewhere. */
export function planCranes(buildings: Building[], ground: Ground): void {
  const half = ((ground.N - 1) * ground.cell) / 2;
  const groundAt = (x: number, z: number) => sampleGrid(ground.heights, ground.N, (x + half) / ground.cell, (z + half) / ground.cell);
  const frac = (b: Building, salt: number) => hash32(b.seed, salt) / 4294967296;
  const placed: Crane[] = [];

  for (const b of buildings) {
    b.crane = null;
    if (b.condition !== 'construction' || frac(b, 0xc4a1) >= CRANE_SHARE) continue;
    const spec = buildingSpec(b.seed, b.type);
    // Tallest block (a tower, not its podium); mast towards its back.
    const main = spec.parts.filter((p) => p.kind === 'block').reduce((a, p) => (p.y + p.h > a.y + a.h ? p : a));
    const lx = main.x + (frac(b, 0xc4a2) - 0.5) * main.w * 0.4, lz = main.z - main.d * (0.15 + frac(b, 0xc4a3) * 0.15);
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const x = b.x + lx * c + lz * s, z = b.z - lx * s + lz * c;
    const jib = Math.max(main.w, main.d) * 0.8 + 12 + frac(b, 0xc4a4) * 8, counter = jib * 0.3;
    const minHeight = main.y + main.h + TOP_CLEAR;

    let best: { heading: number; height: number } | null = null;
    const start = frac(b, 0xc4a5) * Math.PI * 2;
    for (let k = 0; k < HEADINGS; k++) {
      const heading = start + (k / HEADINGS) * Math.PI * 2;
      const need = requiredHeight(b, x, z, heading, jib, counter);
      if (need !== null && (!best || need < best.height)) best = { heading, height: need };
    }
    if (!best) continue; // boxed in by other cranes: no crane here
    const crane: Crane = { x, y: b.y, z, height: Math.max(minHeight, best.height), jib, counter, heading: best.heading };
    b.crane = crane;
    placed.push(crane);
  }

  /** Lowest mast (above b.y) for a beam at `heading`, or null if that heading hits another crane. */
  function requiredHeight(b: Building, x: number, z: number, heading: number, jib: number, counter: number): number | null {
    const dx = Math.sin(heading), dz = Math.cos(heading);
    const a = { x: x - dx * counter, z: z - dz * counter }, e = { x: x + dx * jib, z: z + dz * jib };
    let need = 0;
    for (let t = -counter; t <= jib + 1e-6; t += STEP) {
      const px = x + dx * t, pz = z + dz * t;
      need = Math.max(need, groundAt(px, pz) + GROUND_CLEAR - b.y);
      for (const o of buildings) {
        if (o === b || Math.abs(o.x - px) > 60 || Math.abs(o.z - pz) > 60) continue;
        // Inside o's footprint (local frame, 1 m margin)?
        const ox = px - o.x, oz = pz - o.z, oc = Math.cos(o.yaw), os = Math.sin(o.yaw);
        if (Math.abs(ox * oc - oz * os) <= o.width / 2 + 1 && Math.abs(ox * os + oz * oc) <= o.depth / 2 + 1)
          need = Math.max(need, o.y + o.height + BUILDING_CLEAR - b.y);
      }
    }
    for (const o of placed) {
      // Over another mast, or this mast under another beam: never.
      if (segmentDistance(o.x, o.z, a, e) < MAST_REACH) return null;
      const oa = { x: o.x - Math.sin(o.heading) * o.counter, z: o.z - Math.cos(o.heading) * o.counter };
      const oe = { x: o.x + Math.sin(o.heading) * o.jib, z: o.z + Math.cos(o.heading) * o.jib };
      if (segmentDistance(x, z, oa, oe) < MAST_REACH) return null;
      // Crossing beams: this one runs above.
      if (segmentsCross(a, e, oa, oe)) need = Math.max(need, o.y + o.height + CRANE_CLEAR - b.y);
    }
    return need;
  }
}

type P = { x: number; z: number };

/** Plan distance from (x, z) to segment a-b. */
function segmentDistance(x: number, z: number, a: P, b: P): number {
  const vx = b.x - a.x, vz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / (vx * vx + vz * vz || 1)));
  return Math.hypot(x - a.x - vx * t, z - a.z - vz * t);
}

/** Segments a-b and c-d cross (or come within MAST_REACH of each other) in plan. */
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const cross = (p: P, q: P, r: P) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return Math.min(segmentDistance(a.x, a.z, c, d), segmentDistance(b.x, b.z, c, d), segmentDistance(c.x, c.z, a, b), segmentDistance(d.x, d.z, a, b)) < MAST_REACH;
}
