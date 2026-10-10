// Baked atmospheric scattering (Hillaire 2020). Four look-up tables rendered on the GPU:
//  - transmittance (256x64) and multiple scattering (32x32): depend on the atmosphere only, baked once;
//  - sky view (192x108): sky radiance per direction, read by the sky dome and water reflections;
//  - aerial perspective (32x32x64, 3D): light scattered in and transmittance between the observer and a point at a
//    given direction / distance; it replaces distance fog in every map shader (chunks/fog.glsl).
// The last two depend on the sun and moon, so they are rebaked whenever the time of day changes (`bake`), never per
// frame. The observer is at a fixed altitude (VIEW_ALT_KM); the map is small, so world distances are stretched by
// AERIAL_KM_PER_UNIT to give it the haze of a much larger landscape.

import * as THREE from 'three';
import { profiler } from '../core/profiler.ts';
import postVertex from './shaders/post.vert.glsl';
import atmosphereFragment from './shaders/atmosphere.frag.glsl';

/** Earth-like atmosphere, km and per-km coefficients. Shared with GLSL through `atmosphereDefines`. */
export const ATMOSPHERE = {
  groundRadius: 6360,
  topRadius: 6460,
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighHeight: 8,
  mieScattering: 9e-3, // heavier haze than clear air: damp overcast
  mieAbsorption: 1e-3,
  mieHeight: 1.2,
  mieG: 0.8,
  ozoneAbsorption: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCenter: 25,
  ozoneWidth: 15,
  groundAlbedo: 0.3,
};

/** Observer altitude of the sky / aerial LUTs, km. */
const VIEW_ALT_KM = 0.2;
/** Atmosphere km per world unit (1 m) in the aerial perspective: the map gets the haze of a ~6x larger landscape. */
const AERIAL_KM_PER_UNIT = 0.008;
/** Mie forward peak of the aerial perspective (the sky keeps ATMOSPHERE.mieG): looking into a low sun stays readable. */
const AERIAL_MIE_G = 0.55;
/** Farthest distance in the aerial LUT, km: its last slice is (nearly) opaque haze, the colour of the horizon. */
const AERIAL_MAX_KM = 400;
/** Radiance scale of the baked sky / haze (sun illuminance at the top of the atmosphere), matched to the scene's lighting. */
export const SKY_EXPOSURE = 14;
/** Share of the sky / haze brightness removed at full golden hour (see timeOfDay.ts `goldenHour`). */
const GOLDEN_SKY_DIM = 0.55;
/** Moonlight relative to sunlight (artistic: far brighter than real, so nights read). */
const MOON_LIGHT = 0.012;
const MOON_TINT = new THREE.Color(0.75, 0.85, 1.0);

const TRANS_SIZE = [256, 64] as const;
const MS_SIZE = 32;
const SKY_SIZE = [192, 108] as const;
const AERIAL_SIZE = [32, 32, 64] as const;

/** GLSL defines of the atmosphere parameters (chunks/atmosphere.glsl). */
export function atmosphereDefines(): Record<string, string> {
  const a = ATMOSPHERE;
  const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
  const v = (x: readonly number[]) => `vec3(${x.map(f).join(', ')})`;
  return {
    GROUND_R: f(a.groundRadius),
    TOP_R: f(a.topRadius),
    RAY_S: v(a.rayleighScattering),
    RAY_H: f(a.rayleighHeight),
    MIE_S: f(a.mieScattering),
    MIE_A: f(a.mieAbsorption),
    MIE_H: f(a.mieHeight),
    MIE_G: f(a.mieG),
    OZONE_A: v(a.ozoneAbsorption),
    OZONE_CENTER: f(a.ozoneCenter),
    OZONE_WIDTH: f(a.ozoneWidth),
    GROUND_ALBEDO: f(a.groundAlbedo),
    TRANS_W: f(TRANS_SIZE[0]),
    TRANS_H: f(TRANS_SIZE[1]),
    MS_SIZE: f(MS_SIZE),
    VIEW_ALT: f(VIEW_ALT_KM),
    AERIAL_MAX: f(AERIAL_MAX_KM),
  };
}

/**
 * Transmittance from the observer towards `dir` to the top of the atmosphere (CPU, same model as the GLSL): the colour
 * the sun's light keeps through the air. Zero once the ray hits the ground.
 */
export function transmittanceTowards(dir: THREE.Vector3, target: THREE.Color): THREE.Color {
  const a = ATMOSPHERE;
  const r0 = a.groundRadius + VIEW_ALT_KM;
  // Ray from (0, r0, 0) along dir: ground / top hits.
  const b = r0 * dir.y;
  const groundDisc = b * b - (r0 * r0 - a.groundRadius * a.groundRadius);
  if (groundDisc >= 0 && -b - Math.sqrt(groundDisc) > 0) return target.setRGB(0, 0, 0);
  const tMax = -b + Math.sqrt(b * b - (r0 * r0 - a.topRadius * a.topRadius));
  const steps = 40;
  const dt = tMax / steps;
  let dr = 0, dg = 0, db = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const h = Math.max(0, Math.hypot(dir.x * t, r0 + dir.y * t, dir.z * t) - a.groundRadius);
    const ray = Math.exp(-h / a.rayleighHeight) * dt;
    const mie = Math.exp(-h / a.mieHeight) * (a.mieScattering + a.mieAbsorption) * dt;
    const ozone = Math.max(0, 1 - Math.abs(h - a.ozoneCenter) / a.ozoneWidth) * dt;
    dr += a.rayleighScattering[0] * ray + mie + a.ozoneAbsorption[0] * ozone;
    dg += a.rayleighScattering[1] * ray + mie + a.ozoneAbsorption[1] * ozone;
    db += a.rayleighScattering[2] * ray + mie + a.ozoneAbsorption[2] * ozone;
  }
  return target.setRGB(Math.exp(-dr), Math.exp(-dg), Math.exp(-db));
}

/** Uniforms of the fog chunk (aerial perspective + sky radiance), shared by every map material (`...env.fog`). */
export interface FogUniforms {
  tAerial: THREE.IUniform<THREE.Texture>;
  apSize: THREE.IUniform<THREE.Vector3>;
  /** Aerial LUT depth share (before its sqrt mapping) per world unit; 0 = no aerial perspective (sprite bakes). */
  aerialScale: THREE.IUniform<number>;
  tSkyView: THREE.IUniform<THREE.Texture>;
  skySize: THREE.IUniform<THREE.Vector2>;
}

export class Atmosphere {
  readonly transmittance: THREE.WebGLRenderTarget;
  readonly multiScatter: THREE.WebGLRenderTarget;
  readonly skyView: THREE.WebGLRenderTarget;
  readonly aerial: THREE.WebGL3DRenderTarget;
  readonly fog: FogUniforms;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private aerialMat: THREE.ShaderMaterial;
  private sunIllum = new THREE.Vector3();
  private moonIllum = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const target = (w: number, h: number, wrapS: THREE.Wrapping = THREE.ClampToEdgeWrapping) => {
      const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      t.texture.wrapS = wrapS;
      return t;
    };
    this.transmittance = target(TRANS_SIZE[0], TRANS_SIZE[1]);
    this.multiScatter = target(MS_SIZE, MS_SIZE);
    this.skyView = target(SKY_SIZE[0], SKY_SIZE[1], THREE.RepeatWrapping);
    this.aerial = new THREE.WebGL3DRenderTarget(AERIAL_SIZE[0], AERIAL_SIZE[1], AERIAL_SIZE[2], { type: THREE.HalfFloatType, depthBuffer: false });
    const ap = this.aerial.texture;
    ap.minFilter = ap.magFilter = THREE.LinearFilter;
    ap.wrapS = THREE.RepeatWrapping;
    ap.wrapT = ap.wrapR = THREE.ClampToEdgeWrapping;
    ap.generateMipmaps = false;

    this.fog = {
      tAerial: { value: ap },
      apSize: { value: new THREE.Vector3(...AERIAL_SIZE) },
      aerialScale: { value: AERIAL_KM_PER_UNIT / AERIAL_MAX_KM },
      tSkyView: { value: this.skyView.texture },
      skySize: { value: new THREE.Vector2(...SKY_SIZE) },
    };

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const luts = { tTransmittance: { value: this.transmittance.texture }, tMultiScatter: { value: this.multiScatter.texture } };
    const lights = { sunDir: { value: new THREE.Vector3(0, 1, 0) }, moonDir: { value: new THREE.Vector3(0, -1, 0) }, sunIllum: { value: this.sunIllum }, moonIllum: { value: this.moonIllum } };
    this.skyMat = bakePass('PASS_SKYVIEW', { ...luts, ...lights, mieG: { value: ATMOSPHERE.mieG }, skySize: this.fog.skySize });
    this.aerialMat = bakePass('PASS_AERIAL', { ...luts, ...lights, mieG: { value: AERIAL_MIE_G }, apSize: this.fog.apSize, slice: { value: 0 } });

    // Static tables.
    const transMat = bakePass('PASS_TRANSMITTANCE', {});
    const msMat = bakePass('PASS_MULTISCATTER', { tTransmittance: luts.tTransmittance });
    this.draw(transMat, this.transmittance);
    this.draw(msMat, this.multiScatter);
    transMat.dispose();
    msMat.dispose();
  }

  /** Rebakes the sky view and aerial perspective for the environment's sun and moon. `moonLit`: lit share of the moon disc. */
  bake(sunDir: THREE.Vector3, moonDir: THREE.Vector3, moonLit: number, golden = 0): void {
    // At sunrise / sunset the sky and haze glow brightly towards the sun: bake them dimmer (surfaces' sunlight is separate).
    this.sunIllum.setScalar(SKY_EXPOSURE * (1 - GOLDEN_SKY_DIM * golden));
    const m = SKY_EXPOSURE * MOON_LIGHT * moonLit;
    this.moonIllum.set(MOON_TINT.r * m, MOON_TINT.g * m, MOON_TINT.b * m);
    for (const mat of [this.skyMat, this.aerialMat]) {
      mat.uniforms.sunDir.value.copy(sunDir);
      mat.uniforms.moonDir.value.copy(moonDir);
    }
    profiler.pass('atmosphere bake', () => {
      this.draw(this.skyMat, this.skyView);
      for (let k = 0; k < AERIAL_SIZE[2]; k++) {
        this.aerialMat.uniforms.slice.value = k;
        this.draw(this.aerialMat, this.aerial, k);
      }
    });
  }

  private draw(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget, layer = 0): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.quad.material = material;
    r.setRenderTarget(target, layer);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
  }
}

function bakePass(pass: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: postVertex,
    fragmentShader: atmosphereFragment,
    defines: { [pass]: '', ...atmosphereDefines() },
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}
