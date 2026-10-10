// Downloads real-world mountain elevation and writes it as 16-bit greyscale heightmaps for the mountain
// generator (src/terrain/mountains/). Run: `pnpm heightmaps` (needs network; output is committed, Git LFS).
//
// Source: AWS Terrain Tiles (Mapzen "terrarium" encoding, public, no key: SRTM / GMTED / ETOPO based),
// https://registry.opendata.aws/terrain-tiles/. Each region is a `km` square around its centre, resampled
// to OUT x OUT and stretched to the full 16-bit range (the generator rescales heights to game size anyway).
// `--preview <dir>` also writes an 8-bit hillshade of each heightmap there for a quick look.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPngChunks, unfilterPng } from '../src/core/png.ts';
import { MOUNTAIN_PATCHES, MOUNTAIN_PATCH_SIZE as OUT } from '../src/terrain/mountains/library.ts';

const OUT_DIR = fileURLToPath(new URL('../public/assets/heightmaps/', import.meta.url));
const TILE_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const ZOOM = 12;
const TILE = 256;

/** Real places, one per patch name in MOUNTAIN_PATCHES (same order). */
const REGIONS: Record<string, { lat: number; lon: number; km: number; note: string }> = {
  alps: { lat: 46.5, lon: 7.95, km: 20, note: 'Bernese Oberland, Switzerland (sharp alpine)' },
  rockies: { lat: 37.95, lon: -107.75, km: 20, note: 'San Juan Mountains, Colorado' },
  zagros: { lat: 32.37, lon: 50.07, km: 20, note: 'Zard Kuh, High Zagros, Iran (folded ridges)' },
  highlands: { lat: 57.07, lon: -3.68, km: 20, note: 'Cairngorms, Scottish Highlands (rounded, glaciated)' },
  caucasus: { lat: 43.25, lon: 42.6, km: 20, note: 'Greater Caucasus, Russia / Georgia' },
};

const previewArg = process.argv.indexOf('--preview');
const previewDir = previewArg >= 0 ? process.argv[previewArg + 1] : null;

// ---------- PNG encoder (greyscale 8 / 16 bit) ----------

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

/** Greyscale PNG; every row gets the Up filter (smooth heights compress far better than unfiltered). */
function encodeGreyPNG(w: number, h: number, bitDepth: 8 | 16, pixels: Uint8Array): Buffer {
  const stride = (w * bitDepth) / 8;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) {
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      raw[y * (stride + 1) + 1 + x] = (pixels[y * stride + x] - up) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 0; // colour type: greyscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Tiles ----------

/** Global Web Mercator pixel coordinates at ZOOM. */
function lonLatToPixel(lon: number, lat: number): [number, number] {
  const n = TILE * 2 ** ZOOM;
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}

/** Elevation (m) of one terrarium tile, TILE x TILE. */
async function fetchTile(x: number, y: number): Promise<Float32Array> {
  const res = await fetch(TILE_URL(ZOOM, x, y));
  if (!res.ok) throw new Error(`tile ${ZOOM}/${x}/${y}: HTTP ${res.status}`);
  const chunks = readPngChunks(new Uint8Array(await res.arrayBuffer()));
  const img = unfilterPng(chunks, inflateSync(chunks.idat));
  if (img.bitDepth !== 8 || img.channels < 3) throw new Error(`tile ${ZOOM}/${x}/${y}: unexpected format`);
  const out = new Float32Array(TILE * TILE);
  for (let p = 0; p < out.length; p++) {
    const o = p * img.channels;
    out[p] = img.data[o] * 256 + img.data[o + 1] + img.data[o + 2] / 256 - 32768;
  }
  return out;
}

/** Elevation of a region resampled to OUT x OUT (box filter over the source pixels each output pixel covers). */
async function regionHeights(lat: number, lon: number, km: number): Promise<Float32Array> {
  const [cx, cy] = lonLatToPixel(lon, lat);
  const metresPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** ZOOM;
  const half = (km * 500) / metresPerPixel;
  const x0 = cx - half, y0 = cy - half, span = 2 * half;
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.floor((x0 + span) / TILE), ty1 = Math.floor((y0 + span) / TILE);
  const tiles = new Map<string, Float32Array>();
  await Promise.all(
    Array.from({ length: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) }, async (_, k) => {
      const tx = tx0 + (k % (tx1 - tx0 + 1)), ty = ty0 + Math.floor(k / (tx1 - tx0 + 1));
      tiles.set(`${tx},${ty}`, await fetchTile(tx, ty));
    }),
  );
  const at = (px: number, py: number) => {
    const t = tiles.get(`${Math.floor(px / TILE)},${Math.floor(py / TILE)}`)!;
    return t[(py % TILE) * TILE + (px % TILE)];
  };
  // Separable area-weighted resampling: each output pixel averages the source pixels it covers, weighted by the
  // covered fraction (whole-pixel boxes would alternate between 1 and 2 source pixels and leave stripes).
  const sx = Math.floor(x0), sy = Math.floor(y0);
  const sh = Math.ceil(y0 + span) - sy + 1;
  const weights = (start: number) => resampleWeights(start, span / OUT);
  const wx = weights(x0 - sx), wy = weights(y0 - sy);
  const rows = new Float32Array(sh * OUT);
  for (let r = 0; r < sh; r++)
    for (let i = 0; i < OUT; i++) {
      let s = 0;
      for (const [p, w] of wx[i]) s += at(sx + p, sy + r) * w;
      rows[r * OUT + i] = s;
    }
  const out = new Float32Array(OUT * OUT);
  for (let j = 0; j < OUT; j++)
    for (let i = 0; i < OUT; i++) {
      let s = 0;
      for (const [p, w] of wy[j]) s += rows[p * OUT + i] * w;
      out[j * OUT + i] = s;
    }
  return out;
}

/** For each of OUT output pixels starting at source coordinate `start`, `step` source pixels wide: [source index, weight][]. */
function resampleWeights(start: number, step: number): [number, number][][] {
  const out: [number, number][][] = [];
  for (let i = 0; i < OUT; i++) {
    const a = start + i * step, b = a + step;
    const list: [number, number][] = [];
    for (let p = Math.floor(a); p < b; p++) {
      const cover = Math.min(b, p + 1) - Math.max(a, p);
      if (cover > 1e-6) list.push([p, cover / step]);
    }
    out.push(list);
  }
  return out;
}

function percentile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** 8-bit hillshade (sun from the north-west) for eyeballing a heightmap. */
function hillshade(h: Float32Array, relief: number): Uint8Array {
  const out = new Uint8Array(OUT * OUT);
  const lx = -0.5, ly = -0.5, lz = 0.7;
  for (let j = 0; j < OUT; j++) {
    for (let i = 0; i < OUT; i++) {
      const dx = (h[j * OUT + Math.min(OUT - 1, i + 1)] - h[j * OUT + Math.max(0, i - 1)]) * relief;
      const dy = (h[Math.min(OUT - 1, j + 1) * OUT + i] - h[Math.max(0, j - 1) * OUT + i]) * relief;
      const len = Math.hypot(dx, dy, 2);
      const d = (-dx * lx - dy * ly + 2 * lz) / len / Math.hypot(lx, ly, lz);
      out[j * OUT + i] = Math.max(0, Math.min(255, 40 + d * 215));
    }
  }
  return out;
}

// ---------- Main ----------

mkdirSync(OUT_DIR, { recursive: true });
if (previewDir) mkdirSync(previewDir, { recursive: true });

for (const name of MOUNTAIN_PATCHES) {
  const { lat, lon, km, note } = REGIONS[name];
  const t0 = performance.now();
  const h = await regionHeights(lat, lon, km);
  // Stretch to 0..1 from a low percentile (a deep gorge shouldn't squash the rest; flat valley floors are harmless)
  // to the true maximum: clipping the top would cut every summit off flat, which shows as mesas once sampled large.
  const lo = percentile(h, 0.002), hi = h.reduce((m, v) => Math.max(m, v), -Infinity);
  const px = new Uint8Array(OUT * OUT * 2);
  for (let p = 0; p < h.length; p++) {
    const v = Math.round(Math.max(0, Math.min(1, (h[p] - lo) / (hi - lo))) * 65535);
    px[p * 2] = v >> 8;
    px[p * 2 + 1] = v & 0xff;
  }
  writeFileSync(`${OUT_DIR}${name}.png`, encodeGreyPNG(OUT, OUT, 16, px));
  if (previewDir) {
    const metresPerOut = (km * 1000) / OUT;
    writeFileSync(`${previewDir}/${name}.png`, encodeGreyPNG(OUT, OUT, 8, hillshade(h, 1 / metresPerOut)));
  }
  console.log(`heightmap ${name}.png  ${note}  ${lo.toFixed(0)}..${hi.toFixed(0)} m  ${(performance.now() - t0).toFixed(0)}ms`);
}
