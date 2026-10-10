// Minimal PNG decoder (no deps): non-interlaced greyscale / RGB / RGBA, 8 or 16 bits per channel.
// Inflating is left to the caller (zlib in Node, DecompressionStream in browsers), so this stays sync and pure.

export interface PngImage {
  width: number;
  height: number;
  /** Bits per channel (8 or 16). */
  bitDepth: number;
  /** Channels per pixel (1 grey, 3 RGB, 4 RGBA). */
  channels: number;
  /** Unfiltered pixel bytes, row-major, big-endian samples for 16 bit. */
  data: Uint8Array;
}

export interface PngChunks {
  width: number;
  height: number;
  bitDepth: number;
  channels: number;
  /** Concatenated IDAT payload (zlib stream). */
  idat: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 6: 4 };

/** Splits a PNG file into its header fields and the (still compressed) image data. */
export function readPngChunks(bytes: Uint8Array): PngChunks {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (sig.some((b, i) => bytes[i] !== b)) throw new Error('Not a PNG file');
  let width = 0, height = 0, bitDepth = 0, channels = 0;
  const parts: Uint8Array[] = [];
  for (let p = 8; p < bytes.length; ) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      bitDepth = body[8];
      channels = CHANNELS[body[9]] ?? 0;
      if (!channels || (bitDepth !== 8 && bitDepth !== 16) || body[12] !== 0)
        throw new Error(`Unsupported PNG (colour type ${body[9]}, depth ${bitDepth}, interlace ${body[12]})`);
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const idat = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of parts) {
    idat.set(b, o);
    o += b.length;
  }
  return { width, height, bitDepth, channels, idat };
}

/** Undoes the per-row filters of the inflated image data. */
export function unfilterPng({ width, height, bitDepth, channels }: PngChunks, inflated: Uint8Array): PngImage {
  const bpp = (channels * bitDepth) / 8;
  const stride = width * bpp;
  if (inflated.length < (stride + 1) * height) throw new Error('PNG data truncated');
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? data[row + x - bpp] : 0;
      const b = y > 0 ? data[prev + x] : 0;
      const c = x >= bpp && y > 0 ? data[prev + x - bpp] : 0;
      let v = inflated[src + x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`Bad PNG filter ${filter}`);
      }
      data[row + x] = v & 0xff;
    }
  }
  return { width, height, bitDepth, channels, data };
}
