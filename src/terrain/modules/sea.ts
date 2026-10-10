// Sea module: picks 0..3 map sides that end in open sea and shapes their coastline.

import { shuffle, type Rng } from '../../core/rng.ts';
import { fbm, smoothstep, type Noise2D } from '../../core/noise.ts';
import { edgeCoords } from '../grid.ts';
import { SIDES, type Side } from '../types.ts';

export interface SeaSide {
  side: Side;
  index: number;
  /** Fraction of the map (from this edge) that is open sea. */
  coast: number;
}

/** Sea width multiplier on maps with three sea sides. */
const ISLAND_COAST_SCALE = 0.6;

export function pickSeaSides(rng: Rng): SeaSide[] {
  const count = Math.floor(rng() * 4); // 0..3
  const chosen = shuffle([...SIDES], rng).slice(0, count);
  // With three sea sides the land would be a narrow island; narrower seas keep room
  // for four well-separated player bases.
  const scale = count === 3 ? ISLAND_COAST_SCALE : 1;
  return chosen
    .sort((a, b) => SIDES.indexOf(a) - SIDES.indexOf(b))
    .map((side) => ({ side, index: SIDES.indexOf(side), coast: (0.12 + rng() * 0.14) * scale }));
}

/** 0 = open sea, 1 = land, with a ragged coastline in between. */
export function seaMask(u: number, v: number, seaSides: SeaSide[], noise: Noise2D, detail: Noise2D): number {
  let mask = 1;
  for (const s of seaSides) {
    const [d, along] = edgeCoords(s.side, u, v);
    const jitter =
      fbm(detail, along * 5 + s.index * 31.7, s.index * 17.3, 4) * 0.09 +
      fbm(noise, u * 10 + 200, v * 10 + 200, 2) * 0.025;
    mask = Math.min(mask, smoothstep(s.coast - 0.1, s.coast + 0.14, d + jitter));
  }
  return mask;
}
