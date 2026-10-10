// Graphics quality presets. Everything that trades looks for speed reads its value from here:
// render resolution, MSAA, the post pass (sun shadows, contact shadows, ambient occlusion),
// how local lights are drawn, and the view distances of billboards / terrain detail / lights.

export const QUALITIES = ['low', 'normal', 'high', 'ultra'] as const;
export type Quality = (typeof QUALITIES)[number];
export const DEFAULT_QUALITY: Quality = 'high';

export interface QualitySettings {
  /** Share of the display resolution that is rendered (the canvas is scaled up to the screen). */
  renderScale: number;
  /** Highest device pixel ratio rendered at, before `renderScale`. */
  pixelRatioCap: number;
  /**
   * Dynamic resolution: when the GPU can't hold ~55 fps, the engine lowers the pixel ratio in 5% steps down to this share
   * of the preset's (and back up when there is headroom). 0 = off (fixed resolution).
   */
  dynamicResolution: number;
  /** MSAA samples of the scene target (post pass only). */
  msaa: number;
  /** Full-screen post pass: sun shadows, contact shadows, ambient occlusion, deferred local lights. Off = scene drawn straight to the screen. */
  post: boolean;
  /** Sun shadow map edge in texels. */
  shadowMap: number;
  /** Shadow-map taps per pixel, offset along the pixel's baked blue-noise direction (soft edges); 1 = a single hardware-filtered tap (hard edges), up to 4. */
  shadowTaps: number;
  /** Screen-space contact shadow ray steps (0 = off). */
  contactSteps: number;
  /** Ambient occlusion taps per half-resolution pixel (0 = off); denoised by a 4x4 blur, so 8 look smooth. */
  aoSamples: number;
  /** Local lights as deferred light volumes; false = cheap glow / pool overlay quads (lights.ts). */
  deferredLights: boolean;
  /** Soft light-shaft cones under spot lights (street lamps); needs the post pass. */
  lightShafts: boolean;
  /** Wet-ground reflection streaks of every light, lit window and sign on asphalt / car parks / sidewalks; needs the post pass. */
  lightReflections: boolean;
  /** HDR bloom mip levels (0 = off); needs the post pass. */
  bloomLevels: number;
  /** Screen-space god rays from the sun; needs the post pass. */
  godRays: boolean;
  /** FXAA edge smoothing in the final pass (for presets without MSAA). */
  fxaa: boolean;
  /** Contrast-adaptive sharpening strength of the final pass, 0-1 (0 = off). */
  sharpen: number;
  /** Fake tilt-shift depth of field strength, 0-1 (0 = off): blurs the top / bottom of the screen when zoomed out. */
  tiltShift: number;
  /** Chromatic aberration towards the screen corners, 0-1 (0 = off). */
  chromatic: number;
  /** Far light halos open into soft out-of-focus bokeh discs (cheap: a vertex-shader size change and a few fragment ops on tiny quads). */
  bokeh: boolean;
  /** Camera distance beyond which trees and rocks are not drawn at all (their sprites cost draw calls and fill rate; the terrain keeps the forest tint). Infinity = no limit. */
  propDistance: number;
  /** Camera distance beyond which trees and rocks are drawn as billboards. */
  spriteDistance: number;
  /** Camera distance beyond which buildings are drawn as simple boxes (windows painted by the shader). */
  buildingDistance: number;
  /** Multiplier on the camera distances where terrain drops to coarser detail levels. */
  terrainLodScale: number;
  /** Street lamp posts beyond half this camera distance are hidden (their lights stay, drawn as discs). */
  lightDistance: number;
  /** Texture anisotropic filtering (clamped to what the GPU supports). */
  anisotropy: number;
  /** Size (per axis, share of the screen) of the deferred light buffer and the light ray / wet reflection target. */
  lightResolution: number;
}

export const QUALITY_SETTINGS: Record<Quality, QualitySettings> = {
  low: {
    renderScale: 0.75, pixelRatioCap: 1, dynamicResolution: 0, msaa: 0, post: false, shadowMap: 0, shadowTaps: 1, contactSteps: 0, aoSamples: 0,
    deferredLights: false, lightShafts: false, lightReflections: false, bloomLevels: 0, godRays: false, bokeh: true, fxaa: true, sharpen: 0.7, tiltShift: 0, chromatic: 0.6, propDistance: 480, spriteDistance: 90, buildingDistance: 180, terrainLodScale: 0.5, lightDistance: 400, anisotropy: 2, lightResolution: 0.25,
  },
  normal: {
    renderScale: 1, pixelRatioCap: 1, dynamicResolution: 0, msaa: 0, post: true, shadowMap: 1024, shadowTaps: 2, contactSteps: 0, aoSamples: 0,
    deferredLights: true, lightShafts: false, lightReflections: true, bloomLevels: 4, godRays: false, bokeh: true, fxaa: true, sharpen: 0.4, tiltShift: 0.6, chromatic: 0.6, propDistance: Infinity, spriteDistance: 150, buildingDistance: 240, terrainLodScale: 0.75, lightDistance: 500, anisotropy: 4, lightResolution: 0.5,
  },
  high: {
    renderScale: 1, pixelRatioCap: 1.25, dynamicResolution: 0.7, msaa: 0, post: true, shadowMap: 2048, shadowTaps: 2, contactSteps: 10, aoSamples: 8,
    deferredLights: true, lightShafts: true, lightReflections: true, bloomLevels: 5, godRays: false, bokeh: true, fxaa: true, sharpen: 0.35, tiltShift: 1, chromatic: 0.6, propDistance: Infinity, spriteDistance: 220, buildingDistance: 320, terrainLodScale: 1, lightDistance: 700, anisotropy: 8, lightResolution: 0.5,
  },
  ultra: {
    renderScale: 1, pixelRatioCap: 1.5, dynamicResolution: 0.6, msaa: 0, post: true, shadowMap: 2048, shadowTaps: 2, contactSteps: 10, aoSamples: 8,
    deferredLights: true, lightShafts: true, lightReflections: true, bloomLevels: 5, godRays: true, bokeh: true, fxaa: true, sharpen: 0.35, tiltShift: 1, chromatic: 0.6, propDistance: Infinity, spriteDistance: 260, buildingDistance: 380, terrainLodScale: 1.25, lightDistance: 850, anisotropy: 8, lightResolution: 0.5,
  },
};

export function isQuality(value: unknown): value is Quality {
  return typeof value === 'string' && (QUALITIES as readonly string[]).includes(value);
}
