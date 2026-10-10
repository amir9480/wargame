// Colour grade as a 3D lookup table (GTA IV style: drained, cold blue-teal cast, gritty S-curve, murky yellow-green mids).
// The grade is evaluated once per cell on the CPU and sampled with one tap per pixel (chunks/grade.glsl), so it is
// free to author per time of day: `bake(daylight)` rebuilds the table (32^3 cells, ~1 ms) when the light changes enough.
// LUT input and output are sRGB-encoded 0-1 colours; brighter HDR values pass through the shader beyond the table.

import * as THREE from 'three';

export const GRADE_LUT_SIZE = 32;
/** Colour kept from the scene: 1 = untouched, 0 = greyscale. */
const SATURATION = 0.52;
const TINT_DAY = [0.9, 0.99, 1.06];
const TINT_NIGHT = [0.84, 0.98, 1.12];
/** Strength of the S-curve (0 = none). */
const CONTRAST = 0.55;
const BLACK_POINT = [0.012, 0.02, 0.026];

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const decode = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export class GradeLut {
  readonly texture: THREE.Data3DTexture;
  private data = new Uint8Array(GRADE_LUT_SIZE ** 3 * 4);
  private baked = -1;

  constructor() {
    const n = GRADE_LUT_SIZE;
    this.texture = new THREE.Data3DTexture(this.data, n, n, n);
    this.texture.format = THREE.RGBAFormat;
    this.texture.type = THREE.UnsignedByteType;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = this.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.bake(1);
  }

  /** Rebuilds the table for `daylight` (0 night - 1 day); skipped while it is within 1/16 of the last bake. */
  bake(daylight: number): void {
    const step = Math.round(daylight * 16);
    if (step === this.baked) return;
    this.baked = step;
    const day = step / 16;
    const n = GRADE_LUT_SIZE;
    const tint = TINT_NIGHT.map((v, i) => v + (TINT_DAY[i] - v) * day);
    // Night: colours stay a little more drained, shadows colder.
    const sat = SATURATION * (0.9 + 0.1 * day);
    const out = this.data;
    let o = 0;
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          const lin = [decode(r / (n - 1)), decode(g / (n - 1)), decode(b / (n - 1))];
          const gl = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
          const shadow = 1 - smooth(0, 0.25, gl);
          const mid = smooth(0.03, 0.2, gl) * (1 - smooth(0.35, 1, gl));
          for (let c = 0; c < 3; c++) {
            let v = gl + (lin[c] - gl) * sat;
            v *= tint[c];
            v *= 1 + ([0.88, 0.98, 1.16][c] - 1) * shadow;
            v *= 1 + ([1.05, 1.03, 0.9][c] - 1) * mid;
            const p = Math.min(1, Math.max(0, encode(Math.max(v, 0))));
            const curved = p + (p * p * (3 - 2 * p) - p) * CONTRAST;
            out[o++] = Math.round(Math.min(1, Math.max(0, curved * 0.96 + BLACK_POINT[c])) * 255);
          }
          out[o++] = 255;
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
