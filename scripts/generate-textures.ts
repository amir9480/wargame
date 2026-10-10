// Generates tileable procedural terrain textures as PNG files.
// Output: public/assets/textures/*.png (served by Vite as static assets).
//
//   pnpm textures:ensure  -> only writes missing files
//   pnpm textures         -> regenerates everything
//
// Runs directly with Node's built-in TypeScript type stripping (Node >= 23.6).

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash32 } from '../src/core/rng.ts';

type RGB = [number, number, number];
type TexelFn = (u: number, v: number, x: number, y: number) => RGB;

const OUT_DIR = fileURLToPath(new URL('../public/assets/textures/', import.meta.url));
const SIZE = 512;
const TEXTURE_SEED = 1337;
const force = process.argv.includes('--force');

// ---------- PNG encoder (RGB8, no deps) ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Tileable noise ----------

function rand2(x: number, y: number, salt: number): number {
  return hash32(hash32(x, y), salt + TEXTURE_SEED) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// Periodic gradient noise: lattice wraps every `period` cells -> seamless tiling.
function pnoise(x: number, y: number, period: number, salt: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const wrap = (n: number) => ((n % period) + period) % period;
  const grad = (ix: number, iy: number, dx: number, dy: number) => {
    const a = rand2(wrap(ix), wrap(iy), salt) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fade(xf), v = fade(yf);
  return 1.4 * mix(
    mix(grad(xi, yi, xf, yf), grad(xi + 1, yi, xf - 1, yf), u),
    mix(grad(xi, yi + 1, xf, yf - 1), grad(xi + 1, yi + 1, xf - 1, yf - 1), u),
    v,
  );
}

// u,v in [0,1). basePeriod = lattice cells across the tile for octave 0.
function tfbm(u: number, v: number, basePeriod: number, octaves: number, salt = 0): number {
  let amp = 1, sum = 0, norm = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * pnoise(u * period, v * period, period, salt + o * 101);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

function tridged(u: number, v: number, basePeriod: number, octaves: number, salt = 0): number {
  let amp = 1, sum = 0, norm = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(pnoise(u * period, v * period, period, salt + o * 101));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

const mixColor = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const scaleColor = (c: RGB, s: number): RGB => [c[0] * s, c[1] * s, c[2] * s];

// ---------- Texture definitions ----------

const TEXTURES: Record<string, TexelFn> = {
  grass(u, v, x, y) {
    const broad = tfbm(u, v, 4, 5, 10);
    const patch = tfbm(u, v, 16, 3, 20);
    const speck = rand2(x, y, 30);
    let c = mixColor([50, 80, 28], [98, 130, 46], clamp01(0.5 + broad * 0.9 + (speck - 0.5) * 0.35));
    c = mixColor(c, [130, 126, 64], clamp01((patch - 0.2) * 2) * 0.35);
    if (speck > 0.94) c = scaleColor(c, 1.18);
    return c;
  },

  sand(u, v, x, y) {
    const warp = tfbm(u, v, 4, 3, 40);
    const ripple = Math.sin(2 * Math.PI * (v * 24 + warp * 1.5));
    const grain = tfbm(u, v, 32, 2, 50);
    const shade = 0.93 + 0.04 * ripple + 0.06 * grain + (rand2(x, y, 60) - 0.5) * 0.08;
    return scaleColor(mixColor([196, 174, 128], [178, 152, 108], clamp01(tfbm(u, v, 2, 3, 70) + 0.5)), shade);
  },

  rock(u, v) {
    const tint = clamp01(tfbm(u, v, 2, 3, 80) + 0.5);
    let c = mixColor([108, 105, 100], [126, 110, 92], tint);
    c = scaleColor(c, 0.78 + 0.4 * tfbm(u, v, 4, 6, 90));
    const crack = tridged(u, v, 6, 3, 100);
    c = scaleColor(c, 1 - 0.55 * clamp01((crack - 0.78) * 5));
    const strata = Math.sin(2 * Math.PI * (v * 10 + tfbm(u, v, 3, 2, 110) * 0.8));
    return scaleColor(c, 0.95 + 0.05 * strata);
  },

  snow(u, v, x, y) {
    const shadow = clamp01(-tfbm(u, v, 4, 3, 120) * 1.4);
    let c = mixColor([236, 241, 248], [196, 210, 232], shadow);
    c = scaleColor(c, 0.94 + 0.06 * tfbm(u, v, 16, 4, 130));
    if (rand2(x, y, 140) > 0.996) c = [255, 255, 255];
    return c;
  },

  dirt(u, v, x, y) {
    let c = mixColor([78, 60, 42], [110, 86, 60], clamp01(tfbm(u, v, 8, 5, 150) + 0.5));
    const pebble = tfbm(u, v, 48, 2, 160);
    if (pebble > 0.42) c = mixColor(c, [142, 128, 108], clamp01((pebble - 0.42) * 6));
    return scaleColor(c, 0.92 + (rand2(x, y, 170) - 0.5) * 0.16);
  },

  asphalt(u, v, x, y) {
    let c = mixColor([46, 46, 48], [70, 69, 68], clamp01(0.5 + tfbm(u, v, 8, 4, 180) * 0.8));
    const aggregate = rand2(x, y, 190);
    if (aggregate > 0.9) c = scaleColor(c, 1.35);
    else if (aggregate < 0.07) c = scaleColor(c, 0.7);
    // Worn / patched areas.
    const wear = clamp01((tfbm(u, v, 3, 3, 195) - 0.15) * 3);
    c = mixColor(c, [84, 82, 78], wear * 0.35);
    const crack = tridged(u, v, 5, 3, 197);
    return scaleColor(c, 1 - 0.4 * clamp01((crack - 0.86) * 8));
  },
};

function renderColorTexture(fn: TexelFn): Uint8Array {
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = fn(x / SIZE, y / SIZE, x, y);
      const k = (y * SIZE + x) * 3;
      rgb[k] = Math.round(c[0]);     // Uint8Array clamps on assignment
      rgb[k + 1] = Math.round(c[1]);
      rgb[k + 2] = Math.round(c[2]);
    }
  }
  return rgb;
}

// Tangent-space normal map from a tileable height field.
function renderWaterNormal(): Uint8Array {
  const H = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      H[y * SIZE + x] = tfbm(u, v, 8, 5, 200) * 0.6 + tfbm(u, v, 24, 3, 210) * 0.25;
    }
  const at = (x: number, y: number) => H[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];
  const strength = 6;
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * strength;
      const ny = -(at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(nx, ny, 1);
      const k = (y * SIZE + x) * 3;
      rgb[k] = Math.round((nx / len * 0.5 + 0.5) * 255);
      rgb[k + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      rgb[k + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
    }
  return rgb;
}

// Blue-noise rotation map for the soft-shadow filter (see post.frag.glsl): per texel the cos / sin of a
// rotation angle in R / G (0.5 = 0) and the plain noise value in B. Built with void-and-cluster, so
// neighbouring texels get well-spread angles and the per-pixel filter noise has no low-frequency blotches.
const NOISE_SIZE = 64;

function renderShadowNoise(): Uint8Array {
  const N = NOISE_SIZE, count = N * N;
  const SIGMA = 1.5, R = 6;
  const kernel: [number, number, number][] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) kernel.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))]);
  const energy = new Float32Array(count);
  const set = new Uint8Array(count);
  const splat = (i: number, sign: number) => {
    const x = i % N, y = (i / N) | 0;
    for (const [dx, dy, w] of kernel) energy[((y + dy + N) % N) * N + ((x + dx + N) % N)] += sign * w;
    set[i] = sign > 0 ? 1 : 0;
  };
  /** Tightest cluster (highest energy among set texels) or largest void (lowest among unset ones). */
  const pick = (cluster: boolean) => {
    let best = -1, bestE = cluster ? -Infinity : Infinity;
    for (let i = 0; i < count; i++) {
      if (!!set[i] !== cluster) continue;
      if (cluster ? energy[i] > bestE : energy[i] < bestE) [best, bestE] = [i, energy[i]];
    }
    return best;
  };

  // Seeded initial pattern, relaxed until no texel wants to move.
  for (let i = 0; i < count; i++) if (rand2(i % N, (i / N) | 0, 4001) < 0.1) splat(i, 1);
  for (;;) {
    const c = pick(true);
    splat(c, -1);
    const v = pick(false);
    splat(v, 1);
    if (v === c) break;
  }
  // Ranks: remove ones from the tightest cluster (ranks ones-1 .. 0), then add at the largest void (ones .. count-1).
  const rank = new Float32Array(count);
  const ones = set.reduce((a, b) => a + b, 0);
  const saved = Uint8Array.from(set), savedEnergy = Float32Array.from(energy);
  for (let r = ones - 1; r >= 0; r--) {
    const c = pick(true);
    splat(c, -1);
    rank[c] = r;
  }
  set.set(saved);
  energy.set(savedEnergy);
  for (let r = ones; r < count; r++) {
    const v = pick(false);
    splat(v, 1);
    rank[v] = r;
  }

  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = rank[i] / count;
    rgb[i * 3] = Math.round((Math.cos(t * Math.PI * 2) * 0.5 + 0.5) * 255);
    rgb[i * 3 + 1] = Math.round((Math.sin(t * Math.PI * 2) * 0.5 + 0.5) * 255);
    rgb[i * 3 + 2] = Math.round(t * 255);
  }
  return rgb;
}

// ---------- Main ----------

mkdirSync(OUT_DIR, { recursive: true });

const jobs: [name: string, render: () => Uint8Array, size?: number][] = [
  ...Object.entries(TEXTURES).map(([name, fn]): [string, () => Uint8Array] => [name, () => renderColorTexture(fn)]),
  ['water_normal', renderWaterNormal],
  ['shadow_noise', renderShadowNoise, NOISE_SIZE],
];

for (const [name, render, size = SIZE] of jobs) {
  const file = `${OUT_DIR}${name}.png`;
  if (!force && existsSync(file)) continue;
  const t0 = performance.now();
  writeFileSync(file, encodePNG(size, size, render()));
  console.log(`texture ${name}.png  ${(performance.now() - t0).toFixed(0)}ms`);
}
