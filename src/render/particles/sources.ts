// Which things on the map emit particles, and where. Pure: reads the finished map and returns emitters (cosmetic choices are
// seeded by the owner's own seed, never by a random stream, so the generator's output is untouched).
//
//   power plants      every chimney stack: dark smoke; every cooling tower: steam
//   factories         the smoke stack of a factory hall (warehouse spec with a tall cylinder part), most of them are running
//   houses            ~35% of villas / farmhouses with a chimney: a faint wisp
// Only intact buildings smoke (abandoned and unfinished ones are cold).

import { hash32 } from '../../core/rng.ts';
import { buildingSpec, siteScale, siteToWorld, type Building, type Terrain } from '../../terrain/generate.ts';
import { toWorld } from '../buildings/geometry.ts';
import { plantCoolers, plantStacks } from '../power.ts';
import type { ParticleEmitter } from './effects.ts';

const CHIMNEY_SHARE = 0.35;
const FACTORY_RUNNING = 0.85;

export function collectEmitters(terrain: Terrain): ParticleEmitter[] {
  const out: ParticleEmitter[] = [];

  for (const s of terrain.power.sites) {
    if (s.kind !== 'plant') continue;
    const k = 0.6 + 0.4 * siteScale(s); // plume size follows the (shrunk) plant
    for (const [i, st] of plantStacks(s).entries()) {
      const [x, y, z] = siteToWorld(s, st.x, st.height, st.z);
      out.push({ effect: 'stackSmoke', x, y, z, seed: hash32(s.seed, 0x5a00 + i), scale: k, intensity: 0.8 + 0.2 * ((hash32(s.seed, 0x5a10 + i) % 100) / 100) });
    }
    for (const [i, c] of plantCoolers(s).entries()) {
      const [x, y, z] = siteToWorld(s, c.x, c.height, c.z);
      out.push({ effect: 'steam', x, y, z, seed: hash32(s.seed, 0x5b00 + i), scale: (c.radius / 8) * k });
    }
  }

  for (const b of terrain.buildings) {
    if (b.condition !== 'intact') continue;
    if (b.type === 'warehouse') {
      const stack = factoryStack(b);
      if (stack && hash32(b.seed, 0x5c00) % 100 < FACTORY_RUNNING * 100) out.push({ effect: 'factorySmoke', ...stack, seed: hash32(b.seed, 0x5c01) });
    } else if (b.type === 'villa' || b.type === 'farmhouse') {
      if (hash32(b.seed, 0x5d00) % 100 >= CHIMNEY_SHARE * 100) continue;
      const pot = chimneyPot(b);
      if (pot) out.push({ effect: 'chimney', ...pot, seed: hash32(b.seed, 0x5d01) });
    }
  }
  return out;
}

/** Top of a factory hall's smoke stack (the tall cylinder part), in world coordinates. */
function factoryStack(b: Building): { x: number; y: number; z: number } | null {
  const part = buildingSpec(b.seed, b.type).parts.find((p) => p.kind === 'cylinder' && p.h >= 12);
  if (!part) return null;
  const [x, y, z] = toWorld(b, [part.x, part.y + part.h, part.z]);
  return { x, y, z };
}

/** Top of a house's chimney (a narrow, tall detail slab), in world coordinates. */
function chimneyPot(b: Building): { x: number; y: number; z: number } | null {
  const part = buildingSpec(b.seed, b.type).parts.find((p) => p.kind === 'slab' && p.detail && p.w < 1 && p.d < 1 && p.h >= 2.4);
  if (!part) return null;
  const [x, y, z] = toWorld(b, [part.x, part.y + part.h, part.z]);
  return { x, y, z };
}
