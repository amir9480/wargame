// Real-world mountain heightmaps (scripts/fetch-heightmaps.ts writes them from public elevation data).
// The relief module samples them for the shape of mountains instead of noise; where mountains stand and how
// high they get is still decided by the generator. Loading is async (fetch / fs), sampling is sync and pure.

import { readPngChunks, unfilterPng } from '../../core/png.ts';
import { hash32 } from '../../core/rng.ts';

/** Patch names in library order: Alps, Rocky Mountains, Zagros, Scottish Highlands, Caucasus. */
export const MOUNTAIN_PATCHES = ['alps', 'rockies', 'zagros', 'highlands', 'caucasus'] as const;
export type MountainPatchName = (typeof MOUNTAIN_PATCHES)[number];

/** Pixels per patch edge. */
export const MOUNTAIN_PATCH_SIZE = 512;

/** One heightmap: `size` x `size` heights, 0..1 (lowest .. highest point of the real area). */
export interface MountainPatch {
  name: MountainPatchName;
  size: number;
  data: Float32Array;
}

export type MountainLibrary = readonly MountainPatch[];

/** Turns a 16-bit greyscale heightmap PNG into a patch; `inflate` decompresses a zlib stream. */
export async function decodeMountainPatch(
  name: MountainPatchName, bytes: Uint8Array, inflate: (zlib: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<MountainPatch> {
  const chunks = readPngChunks(bytes);
  if (chunks.bitDepth !== 16 || chunks.channels !== 1 || chunks.width !== chunks.height)
    throw new Error(`heightmap ${name}: expected a square 16-bit greyscale PNG`);
  const img = unfilterPng(chunks, await inflate(chunks.idat));
  const data = new Float32Array(img.width * img.height);
  for (let p = 0; p < data.length; p++) data[p] = ((img.data[p * 2] << 8) | img.data[p * 2 + 1]) / 65535;
  return { name, size: img.width, data };
}

/** Loads every patch over HTTP (`baseUrl` ends with '/'); works in pages and workers. */
export function fetchMountainLibrary(baseUrl: string): Promise<MountainLibrary> {
  const inflate = async (zlib: Uint8Array) => {
    const stream = new Blob([zlib as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  return Promise.all(
    MOUNTAIN_PATCHES.map(async (name) => {
      const res = await fetch(`${baseUrl}${name}.png`);
      if (!res.ok) throw new Error(`heightmap ${name}: HTTP ${res.status}`);
      return decodeMountainPatch(name, new Uint8Array(await res.arrayBuffer()), inflate);
    }),
  );
}

/**
 * Where a map reads a patch: (i, j) cells from the grid centre map to patch pixel `origin + rotate(i, j) * scale`, with one of
 * the 8 square symmetries (4 turns, optionally mirrored), so one patch gives many different mountains.
 */
export interface PatchView {
  patch: MountainPatch;
  /** Patch pixels per grid cell. */
  scale: number;
  ox: number;
  oy: number;
  /** 0..7: bit 0 mirror, bits 1-2 quarter turns. */
  orient: number;
  /** Patch heights mapped to 0 / 1: the low / high end of the relief inside the window the view covers. */
  lo: number;
  hi: number;
}

/**
 * Patch pixels per grid cell. A patch is 20 km of real ground (~39 m per pixel), so 1 cell (2 m) ~ 9.8 m: the
 * real ground is squeezed only ~5x, a mountain a few km across stays a few hundred metres wide on the map, and
 * the grid shows a ~3.7 km window of the patch (heights are scaled separately, see relief.ts / ranges.ts).
 */
const PATCH_SCALE = 0.25;
/** Windows tried per view; the one with the most relief wins (hashes, no rng). */
const VIEW_TRIES = 6;
/** Least relief (patch units) a window is stretched from, so a flat window isn't blown up into noise. */
const MIN_RELIEF = 0.15;

/**
 * Seeded view of a seeded patch, from hashes (no rng stream). `salt` tells apart the views of one map (inland
 * peaks, each edge range). Coordinates are play-area cells, so a view covers the grid without mirroring. Of a
 * few seeded windows the most mountainous is kept, and its relief is stretched to 0..1.
 */
export function pickPatchView(library: MountainLibrary, seed: number, salt: number, extent: number): PatchView {
  const h = (k: number) => hash32(hash32(seed, 0x6d6f756e + salt), k) / 4294967296;
  const patch = library[Math.floor(h(0) * library.length)];
  // Samples are taken relative to the grid centre; `extent` grid cells must fit inside the patch.
  const half = (extent * PATCH_SCALE) / 2;
  const room = Math.max(0, patch.size - 1 - 2 * half);
  const c = (patch.size - 1) / 2;
  let best: PatchView | null = null;
  for (let t = 0; t < VIEW_TRIES; t++) {
    const ox = c + (h(1 + 2 * t) - 0.5) * room, oy = c + (h(2 + 2 * t) - 0.5) * room;
    const [lo, hi] = windowRange(patch, ox, oy, half);
    if (!best || hi - lo > best.hi - best.lo) best = { patch, scale: PATCH_SCALE, ox, oy, orient: 0, lo, hi };
  }
  const view = best!;
  view.orient = Math.floor(h(100) * 8);
  if (view.hi - view.lo < MIN_RELIEF) view.lo = Math.max(0, view.hi - MIN_RELIEF);
  return view;
}

/** Low (2nd percentile) and high (max) patch height inside the square window of `half` pixels round (ox, oy). */
function windowRange({ size, data }: MountainPatch, ox: number, oy: number, half: number): [number, number] {
  const x0 = Math.max(0, Math.floor(ox - half)), x1 = Math.min(size - 1, Math.ceil(ox + half));
  const y0 = Math.max(0, Math.floor(oy - half)), y1 = Math.min(size - 1, Math.ceil(oy + half));
  const values: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) values.push(data[y * size + x]);
  values.sort((a, b) => a - b);
  return [values[Math.floor(values.length * 0.02)], values[values.length - 1]];
}

/**
 * How much of a mountain shape stands above the ground for an envelope `amount` 0..1: the shape is "flooded"
 * from below, so as the envelope fades out the valleys fill first and only the higher peaks and ridges still
 * show (foothills), instead of the whole mountain shrinking. Soft knee at the waterline (no crease).
 */
export function floodShape(height: number, amount: number): number {
  const x = height - (1 - amount);
  const knee = 0.08;
  if (x <= -knee) return 0;
  if (x >= knee) return x;
  return ((x + knee) * (x + knee)) / (4 * knee);
}

/**
 * Height 0..1 of the patch seen through `view` at (i, j) cells from the grid centre (the window's relief stretched,
 * clamped). Bicubic (Catmull-Rom), since a pixel spans several cells and bilinear would show its facets; mirrored
 * past the patch edges.
 */
export function samplePatch({ patch, scale, ox, oy, orient, lo, hi }: PatchView, i: number, j: number): number {
  let a = i * scale, b = j * scale;
  if (orient & 1) a = -a;
  for (let t = orient >> 1; t > 0; t--) [a, b] = [-b, a];
  const { size, data } = patch;
  const x = mirror(ox + a, size), y = mirror(oy + b, size);
  const x0 = Math.min(size - 2, Math.floor(x)), y0 = Math.min(size - 2, Math.floor(y));
  const fx = x - x0, fy = y - y0;
  const row = (yy: number) => {
    const k = clampIndex(yy, size) * size;
    return catmullRom(
      data[k + clampIndex(x0 - 1, size)], data[k + x0], data[k + x0 + 1], data[k + clampIndex(x0 + 2, size)], fx,
    );
  };
  const v = catmullRom(row(y0 - 1), row(y0), row(y0 + 1), row(y0 + 2), fy);
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

function clampIndex(k: number, size: number): number {
  return k < 0 ? 0 : k >= size ? size - 1 : k;
}

/** Folds any coordinate into 0..size-1, mirroring at the edges (no seams). */
function mirror(x: number, size: number): number {
  const period = 2 * (size - 1);
  const m = ((x % period) + period) % period;
  return m < size - 1 ? m : period - m;
}
