// HDR post effects computed from the scene target before the post pass, which adds their results:
//  - Bloom: dual-filter mip chain (half resolution down to 1/2^levels), soft threshold. Levels from QualitySettings.bloomLevels.
//  - GodRays: screen-space radial blur towards the sun (QualitySettings.godRays, ultra only).

import * as THREE from 'three';
import postVertex from './shaders/post.vert.glsl';
import bloomFragment from './shaders/bloom.frag.glsl';
import godraysFragment from './shaders/godrays.frag.glsl';

/** Full-screen pass of `material` into `target`. */
export type FullScreenPass = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => void;

/** Scene brightness where bloom starts (a white surface in full sun is ~1.4) and the width of its soft knee. */
const BLOOM_THRESHOLD = 1.6;
const BLOOM_KNEE = 0.6;
/** Bloom added to the scene, per level (the chain sums its levels). */
export const BLOOM_STRENGTH = 0.12;
/** God ray brightness. */
const GOD_STRENGTH = 0.5;

function material(fragment: string, define: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: define.replace('PASS_', '').toLowerCase(), // pass name in the profiler report
    vertexShader: postVertex,
    fragmentShader: fragment,
    defines: { [define]: '' },
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

export class Bloom {
  private levels: THREE.WebGLRenderTarget[] = [];
  private prefilter = material(bloomFragment, 'PASS_PREFILTER', {
    tSource: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: BLOOM_THRESHOLD }, knee: { value: BLOOM_KNEE },
  });
  private down = material(bloomFragment, 'PASS_DOWN', { tSource: { value: null }, texel: { value: new THREE.Vector2() } });
  private up: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;

  constructor() {
    this.up = material(bloomFragment, 'PASS_UP', { tSource: { value: null }, texel: { value: new THREE.Vector2() } });
    this.up.blending = THREE.AdditiveBlending;
    this.up.transparent = true;
  }

  get count(): number {
    return this.levels.length;
  }

  /** Mip chain for a `width` x `height` scene; 0 levels = off (frees the targets). */
  configure(width: number, height: number, levels: number): void {
    this.width = width;
    this.height = height;
    while (this.levels.length > levels) this.levels.pop()!.dispose();
    while (this.levels.length < levels) {
      this.levels.push(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    }
    this.levels.forEach((t, i) => t.setSize(Math.max(1, Math.ceil(width / 2 ** (i + 1))), Math.max(1, Math.ceil(height / 2 ** (i + 1)))));
  }

  /** Runs the chain on `source` (the HDR scene); returns the bloom texture (half resolution), or null when off. */
  render(renderer: THREE.WebGLRenderer, pass: FullScreenPass, source: THREE.Texture): THREE.Texture | null {
    const L = this.levels;
    if (!L.length) return null;
    const pu = this.prefilter.uniforms;
    pu.tSource.value = source;
    pu.texel.value.set(1 / this.width, 1 / this.height);
    pass(this.prefilter, L[0]);
    for (let i = 1; i < L.length; i++) {
      this.down.uniforms.tSource.value = L[i - 1].texture;
      this.down.uniforms.texel.value.set(1 / L[i - 1].width, 1 / L[i - 1].height);
      pass(this.down, L[i]);
    }
    // Upsample: each level gets the next smaller one added on top (no clear).
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    for (let i = L.length - 2; i >= 0; i--) {
      this.up.uniforms.tSource.value = L[i + 1].texture;
      this.up.uniforms.texel.value.set(0.5 / L[i + 1].width, 0.5 / L[i + 1].height);
      pass(this.up, L[i]);
    }
    renderer.autoClear = autoClear;
    return L[0].texture;
  }
}

export class GodRays {
  private target: THREE.WebGLRenderTarget | null = null;
  private material: THREE.ShaderMaterial;
  private clip = new THREE.Vector4();

  constructor(noise: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      name: 'radial blur',
      vertexShader: postVertex,
      fragmentShader: godraysFragment,
      uniforms: {
        tColor: { value: null }, tDepth: { value: null }, tNoise: { value: noise },
        sunUv: { value: new THREE.Vector2() }, aspect: { value: 1 }, strength: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  /** Half-resolution target for a `width` x `height` scene, or none (off). */
  configure(width: number, height: number, on: boolean): void {
    if (!on) {
      this.target?.dispose();
      this.target = null;
      return;
    }
    this.target ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.target.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
  }

  /**
   * Rays for the sun in `sunDir` seen through `viewProj`; null when off or the sun is behind the camera, far off screen
   * or below the horizon. `sunUp` (0-1) fades them with the sunset.
   */
  render(pass: FullScreenPass, color: THREE.Texture, depth: THREE.Texture, viewProj: THREE.Matrix4, camPos: THREE.Vector3, sunDir: THREE.Vector3, sunUp: number, aspect: number): THREE.Texture | null {
    if (!this.target || sunUp <= 0.001) return null;
    const c = this.clip.set(camPos.x + sunDir.x * 1000, camPos.y + sunDir.y * 1000, camPos.z + sunDir.z * 1000, 1).applyMatrix4(viewProj);
    if (c.w <= 0) return null;
    const x = (c.x / c.w) * 0.5 + 0.5, y = (c.y / c.w) * 0.5 + 0.5;
    // Fade out as the sun leaves the screen (shafts still reach in from just outside it).
    const off = Math.max(0, Math.abs(x - 0.5) - 0.5, Math.abs(y - 0.5) - 0.5);
    const strength = GOD_STRENGTH * sunUp * (1 - THREE.MathUtils.smoothstep(off, 0, 0.35));
    if (strength <= 0.001) return null;
    const u = this.material.uniforms;
    u.tColor.value = color;
    u.tDepth.value = depth;
    u.sunUv.value.set(x, y);
    u.aspect.value = aspect;
    u.strength.value = strength;
    pass(this.material, this.target);
    return this.target.texture;
  }
}
