// Directional-light shadows + screen-space effects, restricted to the area around the camera focus.
//
// Frame: (1) shadow-map pass of the casters near the focus from the sun's point of view,
// (2) the scene into an MSAA half-float target with a depth texture, (3) one full-screen pass that
// rebuilds world positions from depth and applies the shadow map, contact shadows and ambient
// occlusion, then converts to the output colour space. The material shaders stay untouched.
// Everything is faded out beyond the region radius, which follows the zoom level.

import * as THREE from 'three';
import type { CullStats } from './culling.ts';
import type { Environment, World } from './world.ts';
import postVertex from './shaders/post.vert.glsl';
import postFragment from './shaders/post.frag.glsl';
import gradeFragment from './shaders/grade.frag.glsl';
import finalFragment from './shaders/final.frag.glsl';
import { GradeLut } from './gradeLut.ts';
import { profiler, POST_PASS, ABLATION } from '../core/profiler.ts';

/** Detail-mode post probes: frames per cycle (five features, one probe each, see `Lighting.drawPost`). */
const PROBE_CYCLE = 30;import aoFragment from './shaders/ao.frag.glsl';
import type { QualitySettings } from './quality.ts';
import { Bloom, BLOOM_STRENGTH, GodRays } from './postfx.ts';
import { DEBUG_SHADER_ID, type DebugView } from './debugView.ts';

/** Final pass look (final.frag.glsl, every quality). The colour grade itself is the LUT in gradeLut.ts. */
const VIGNETTE = 0.35;
const CORNER = 0.4;
const GRAIN = 0.008;
/** Tilt-shift blur fades in with the zoom distance between these (close-up views stay sharp). */
const TILT_ZOOM_START = 150;
const TILT_ZOOM_END = 400;
/** Region radius (world units) = zoom distance * this, clamped. */
const REGION_PER_DISTANCE = 0.45;
const REGION_MIN = 130; // close zoom still sees far ground towards the horizon: cover the whole screen
const REGION_MAX = 200;
const SHADOW_FADE_END = 700; // camera distance (m) beyond which nothing is shadowed (post.frag.glsl SHADOW_FADE_END)
const SHADOW_SUN_STEP = 0.0045; // radians (~0.25 deg) the sun may move before the cached shadow map is redrawn
const SHADOW_CAMERA_STEP = 6; // m the (culling) camera may move before it: casters switch detail level by camera distance
/** Ambient occlusion sample radius, world units. */
const AO_RADIUS = 3;

/** How far above the focus the shadow camera sits: casters taller than this are clipped. */
const LIGHT_HEIGHT = 320;

export class Lighting {
  /** When false the scene renders straight to the screen, with no shadows or occlusion (the `post` quality setting). */
  enabled = true;

  private renderer: THREE.WebGLRenderer;
  private env: Environment;
  private sunDir: THREE.Vector3;
  private sceneTarget!: THREE.WebGLRenderTarget;
  /** Irradiance of the deferred local lights (see lights.ts), added to the scene in the post pass. */
  private lightTarget: THREE.WebGLRenderTarget;
  private lightAllocated = false;
  /** Light rays (lights.ts), marched at half resolution and added in the post pass. */
  private rayTarget: THREE.WebGLRenderTarget;
  private rayAllocated = false;
  private shadowTarget!: THREE.WebGLRenderTarget;
  private shadowSize = 2048;
  private settings: QualitySettings;
  private depthMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
  /** Debug view (see debugView.ts); the ones that need the post pass show the normal image where it is off (low quality). */
  debugView: DebugView = 'final';
  /** Triangles views: every mesh redrawn with one of these (solid dark fill for occlusion, then white lines nudged towards the camera). */
  private wireFill = new THREE.MeshBasicMaterial({ color: 0x06080b, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, toneMapped: false });
  private wireLine = (() => {
    const m = new THREE.MeshBasicMaterial({ color: 0xcfe6ff, wireframe: true, depthWrite: false, toneMapped: false });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n gl_Position.z -= 3e-4 * gl_Position.w;');
    };
    return m;
  })();
  private lightCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100);
  /**
   * Shadow map cache: the map holds what the light camera saw when it was last drawn. It is redrawn only when the sun moved
   * `SHADOW_SUN_STEP` radians, the (texel-snapped) light camera view or its region changed, the main camera moved
   * `SHADOW_CAMERA_STEP` m (casters' detail levels), or the casters changed
   * (`World.shadowEpoch`); otherwise last frame's map is used as is, with the light camera left where it was.
   */
  private shadowCache = { valid: false, ix: 0, iy: 0, region: 0, epoch: -1, sun: new THREE.Vector3(), cam: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
  private lightRight = new THREE.Vector3();
  private lightUp = new THREE.Vector3();
  private basisCamera = new THREE.OrthographicCamera(); // camera convention: looks down -Z, like the light camera
  private postScene = new THREE.Scene();
  private postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMaterial: THREE.ShaderMaterial;
  /** Grade-only pass for the preset without the post pass (the scene is drawn into `sceneTarget` first). */
  private gradeMaterial: THREE.ShaderMaterial;
  /** Colour-grade lookup table (chunks/grade.glsl), rebaked as the daylight changes. */
  private gradeLut = new GradeLut();
  private gradeUniforms = { tGradeLut: { value: this.gradeLut.texture } };
  /** Graded, display-encoded image (RGBA8) that the final pass reads. */
  private ldrTarget!: THREE.WebGLRenderTarget;
  /** Final pass to the screen: FXAA, sharpening, tilt-shift, chromatic aberration, vignette, grain (final.frag.glsl). */
  private finalMaterial: THREE.ShaderMaterial;
  private postQuad: THREE.Mesh;
  /** Half-resolution ambient occlusion chain (see ao.frag.glsl): linear depth, raw occlusion, blurred occlusion. */
  private zTarget: THREE.WebGLRenderTarget;
  private aoTarget: THREE.WebGLRenderTarget;
  private aoBlurTarget: THREE.WebGLRenderTarget;
  private aoDepthMaterial: THREE.ShaderMaterial;
  private aoMaterial: THREE.ShaderMaterial | null = null;
  private aoBlurMaterial: THREE.ShaderMaterial;
  private aoTaps = 0;
  private size = new THREE.Vector2();
  private tmp = new THREE.Vector3();
  /** The shadow texture must exist (be allocated) before the post pass samples it, even if the sun never was up. */
  private shadowAllocated = false;
  private viewProj = new THREE.Matrix4();
  private bloom = new Bloom();
  private godRays: GodRays;
  private passFn = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => this.pass(material, target);
  /** Profiler: the pass group the full-screen passes being drawn belong to (see `grouped`), and the post-probe frame counter. */
  private group = '';
  private probeFrame = 0;

  constructor(renderer: THREE.WebGLRenderer, env: Environment, settings: QualitySettings, noise: THREE.Texture) {
    this.renderer = renderer;
    this.env = env;
    this.godRays = new GodRays(noise);
    this.sunDir = env.sunDir;
    this.settings = settings;
    this.enabled = settings.post;
    renderer.getDrawingBufferSize(this.size);

    this.lightTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rayTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rayTarget.texture.minFilter = this.rayTarget.texture.magFilter = THREE.LinearFilter;
    const half = (type: THREE.TextureDataType, format: THREE.PixelFormat) =>
      new THREE.WebGLRenderTarget(Math.ceil(this.size.x / 2), Math.ceil(this.size.y / 2), {
        type, format, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
    this.zTarget = half(THREE.FloatType, THREE.RedFormat); // full float: view depth must stay precise far away
    this.aoTarget = half(THREE.HalfFloatType, THREE.RGFormat);
    this.aoBlurTarget = half(THREE.HalfFloatType, THREE.RGFormat);
    this.aoDepthMaterial = aoPass('PASS_DEPTH', { tDepth: { value: null }, camNear: { value: 1 }, camFar: { value: 4000 } });
    this.aoBlurMaterial = aoPass('PASS_BLUR', { tAO: { value: this.aoTarget.texture }, size: { value: new THREE.Vector2() } });

    this.postMaterial = new THREE.ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: postFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tShadow: { value: null },
        tLight: { value: this.lightTarget.texture },
        tNoise: { value: noise },
        tRay: { value: this.rayTarget.texture },
        rayOn: { value: 0 },
        lightOn: { value: 0 },
        lightSize: { value: new THREE.Vector2(1, 1) },
        invViewProj: { value: new THREE.Matrix4() },
        viewProj: { value: new THREE.Matrix4() },
        shadowVP: { value: new THREE.Matrix4() },
        sunDir: { value: this.sunDir },
        focus: { value: new THREE.Vector3() },
        camPos: { value: new THREE.Vector3() },
        regionR: { value: 150 },
        resolution: { value: new THREE.Vector2() },
        pxScale: { value: 1 },
        camNear: { value: 1 },
        camFar: { value: 4000 },
        texelWorld: { value: 0.1 },
        shadowTexel: { value: 1 / 2048 },
        shadowRange: { value: 500 },
        sunLum: { value: 0 },
        ambLum: { value: 0.4 },
        tAO: { value: this.aoBlurTarget.texture },
        aoSize: { value: new THREE.Vector2() },
        aoOn: { value: 0 },
        tBloom: { value: null },
        bloomStrength: { value: 0 },
        tGod: { value: null },
        godOn: { value: 0 },
        ...this.gradeUniforms,
        aoStrength: { value: 1 },
        shadowStrength: { value: 1 },
        debugView: { value: 0 },
        contactLength: { value: 4 },
        shadowTaps: { value: 4 },
        contactSteps: { value: 14 },
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
        ...env.fog,
        fogOrigin: { value: new THREE.Vector3() },
      },
    });
    this.gradeMaterial = new THREE.ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: gradeFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: { tColor: { value: null }, ...this.gradeUniforms },
    });
    this.finalMaterial = new THREE.ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: finalFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        texel: { value: new THREE.Vector2() },
        fxaaOn: { value: 0 },
        sharpen: { value: 0 },
        tilt: { value: 0 },
        chroma: { value: 0 },
        vignette: { value: VIGNETTE },
        corner: { value: CORNER },
        grain: { value: GRAIN },
        time: { value: 0 },
      },
    });
    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.postScene.add(this.postQuad);
    this.buildTargets();
    this.applyFinalSettings();
  }

  private applyFinalSettings(): void {
    const u = this.finalMaterial.uniforms;
    u.texel.value.set(1 / this.size.x, 1 / this.size.y);
    u.fxaaOn.value = this.settings.fxaa ? 1 : 0;
    u.sharpen.value = this.settings.sharpen;
    u.chroma.value = this.settings.chromatic;
  }

  /** Graded image -> screen through the final pass. `distance` = camera zoom distance (tilt-shift only blurs a zoomed-out view). */
  private finish(distance: number): void {
    const r = this.renderer;
    const u = this.finalMaterial.uniforms;
    u.tColor.value = this.ldrTarget.texture;
    u.tilt.value = this.settings.tiltShift * THREE.MathUtils.smoothstep(distance, TILT_ZOOM_START, TILT_ZOOM_END);
    u.time.value = (performance.now() % 100000) / 1000;
    this.postQuad.material = this.finalMaterial;
    profiler.pass('final (FXAA, sharpen, tilt-shift, vignette)', () => {
      r.setRenderTarget(null);
      r.render(this.postScene, this.postCamera);
    });
  }

  /** Applies a quality preset. Call after the renderer's pixel ratio changed (the targets follow the drawing buffer size). */
  setQuality(settings: QualitySettings): void {
    this.settings = settings;
    this.enabled = settings.post;
    this.renderer.getDrawingBufferSize(this.size);
    this.buildTargets();
    this.sizeLightTargets();
    this.resizeAO();
    this.applyFinalSettings();
  }

  /** Deferred light buffer and light ray / reflection target: a share of the screen (`QualitySettings.lightResolution`). */
  private sizeLightTargets(): void {
    const s = this.settings.lightResolution;
    const w = Math.max(1, Math.ceil(this.size.x * s)), h = Math.max(1, Math.ceil(this.size.y * s));
    this.lightTarget.setSize(w, h);
    this.rayTarget.setSize(w, h);
  }

  private resizeAO(): void {
    const w = Math.ceil(this.size.x / 2), h = Math.ceil(this.size.y / 2);
    for (const t of [this.zTarget, this.aoTarget, this.aoBlurTarget]) t.setSize(w, h);
    const post = this.settings.post;
    this.bloom.configure(this.size.x, this.size.y, post ? this.settings.bloomLevels : 0);
    this.godRays.configure(this.size.x, this.size.y, post && this.settings.godRays);
  }

  /**
   * (Re)creates the scene target (MSAA samples) and the sun shadow map (size). GPU memory is only
   * allocated on first use, so the targets of a preset without the post pass cost nothing.
   */
  private buildTargets(): void {
    this.sceneTarget?.dispose();
    this.sceneTarget?.depthTexture?.dispose();
    this.shadowTarget?.dispose();
    this.shadowTarget?.depthTexture?.dispose();

    this.shadowSize = Math.max(16, this.settings.shadowMap);
    const shadowDepth = new THREE.DepthTexture(this.shadowSize, this.shadowSize);
    shadowDepth.type = THREE.UnsignedIntType;
    shadowDepth.compareFunction = THREE.LessEqualCompare; // hardware PCF (sampler2DShadow)
    shadowDepth.minFilter = shadowDepth.magFilter = THREE.LinearFilter;
    this.shadowTarget = new THREE.WebGLRenderTarget(this.shadowSize, this.shadowSize, {
      depthBuffer: true,
      depthTexture: shadowDepth,
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
    });
    this.shadowAllocated = false;
    this.shadowCache.valid = false;

    this.ldrTarget?.dispose();
    this.ldrTarget = new THREE.WebGLRenderTarget(this.size.x, this.size.y, { depthBuffer: false });
    this.ldrTarget.texture.minFilter = this.ldrTarget.texture.magFilter = THREE.LinearFilter;

    const sceneDepth = new THREE.DepthTexture(this.size.x, this.size.y);
    sceneDepth.type = THREE.UnsignedIntType;
    this.sceneTarget = new THREE.WebGLRenderTarget(this.size.x, this.size.y, {
      type: THREE.HalfFloatType,
      samples: this.settings.msaa,
      depthTexture: sceneDepth,
    });

    const u = this.postMaterial.uniforms;
    u.tColor.value = this.sceneTarget.texture;
    u.tDepth.value = sceneDepth;
    u.tShadow.value = shadowDepth;
    u.shadowTexel.value = 1 / this.shadowSize;
    u.shadowTaps.value = this.settings.shadowTaps;
    u.contactSteps.value = this.settings.contactSteps;
    // Tap count is a compile-time constant of the AO shader (unrolled loop).
    if (this.aoTaps !== this.settings.aoSamples) {
      this.aoMaterial?.dispose();
      this.aoTaps = this.settings.aoSamples;
      this.aoMaterial = this.aoTaps > 0
        ? aoPass('PASS_AO', {
          tZ: { value: this.zTarget.texture },
          size: { value: new THREE.Vector2() },
          projScale: { value: new THREE.Vector2() },
          pxScale: { value: 1 },
          aoRadius: { value: AO_RADIUS },
          viewToWorld: { value: new THREE.Matrix4() },
          focus: { value: new THREE.Vector3() },
          regionR: { value: 150 },
        }, { AO_TAPS: String(this.aoTaps) })
        : null;
    }
  }

  /** Call after the renderer / canvas size or pixel ratio changed. */
  resize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    this.sceneTarget.setSize(this.size.x, this.size.y);
    this.ldrTarget.setSize(this.size.x, this.size.y);
    this.sizeLightTargets();
    this.resizeAO();
    this.applyFinalSettings();
  }

  /**
   * Draws one frame. `focus` is the point the camera orbits, `distance` its zoom distance
   * (both set the region that receives shadows / occlusion). Returns the main-view cull stats.
   * `cullCamera` (default `camera`) decides everything the view depends on: frustum culling, LOD levels, shadow casters,
   * light volumes. Debug camera freeze draws from `camera` while it stays the frozen game camera.
   */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, world: World, focus: THREE.Vector3, distance: number, cullCamera: THREE.PerspectiveCamera = camera): CullStats {
    const r = this.renderer;
    world.setSpriteMark(this.enabled);
    if (!this.enabled) {
      this.env.spriteShade.spriteShadow.value = 0; // no shadow map without the post pass
      const stats = world.cull(cullCamera);
      profiler.scope('cull', 'overlay light quads', () => world.lights.cull(cullCamera)); // the deferred volumes are not drawn here
      // No post pass: draw into the scene target (no MSAA), grade it, then the final pass puts it on the screen.
      profiler.scope('render', 'grade LUT bake', () => this.gradeLut.bake(this.env.daylight.value));
      profiler.group('scene (HDR)', () => this.drawMain(scene, camera, world));
      profiler.pass('grade', () => {
        this.gradeMaterial.uniforms.tColor.value = this.sceneTarget.texture;
        this.postQuad.material = this.gradeMaterial;
        r.setRenderTarget(this.ldrTarget);
        r.render(this.postScene, this.postCamera);
      });
      this.finish(distance);
      return stats;
    }

    // In 4 m steps: the smoothed zoom keeps creeping for seconds, which would redraw the cached shadow map every frame.
    const region = Math.min(REGION_MAX, Math.max(REGION_MIN, Math.round((distance * REGION_PER_DISTANCE) / 4) * 4));
    // Direct-light shadows fade out as the sun sets; with the sun down there is nothing to cast them.
    const sunFactor = THREE.MathUtils.smoothstep(this.sunDir.y, 0.03, 0.22);
    const lum = (c: THREE.Color) => (c.r + c.g + c.b) / 3;

    // 1. Shadow map: depth of the casters near the focus, each at the detail level the main view draws it.
    // The whole shadow region beyond the fade range of the camera: no receiver, skip the pass.
    const shadowsInRange = camera.position.distanceTo(focus) - region * Math.SQRT2 < SHADOW_FADE_END;
    if (sunFactor > 0.001 && shadowsInRange) {
      // Would the light camera see something different from what the map holds? Its centre snaps to a texel grid in the
      // light space of the last draw (`cache.right / up`): the same grid cell, sun and casters mean the same picture.
      const cache = this.shadowCache;
      const texel = (2 * region) / this.shadowSize;
      const ix = Math.round(focus.dot(cache.right) / texel), iy = Math.round(focus.dot(cache.up) / texel);
      const epoch = world.shadowEpoch;
      // Casters are drawn at the main camera's detail levels, so a camera that moved (zoom, rotation) changes them too.
      const stale = !cache.valid || !this.shadowAllocated || cache.region !== region || cache.epoch !== epoch || ix !== cache.ix || iy !== cache.iy
        || this.sunDir.dot(cache.sun) < Math.cos(SHADOW_SUN_STEP)
        || cullCamera.position.distanceToSquared(cache.cam) > SHADOW_CAMERA_STEP * SHADOW_CAMERA_STEP;
      profiler.count('shadow', 'map redraws (1 = redrawn this frame)', stale ? 1 : 0);
      if (stale) {
        profiler.scope('render', 'shadow camera setup', () => this.updateLightCamera(this.lightCamera, focus, region));
        cache.valid = true; cache.region = region; cache.epoch = epoch;
        cache.right.copy(this.lightRight); cache.up.copy(this.lightUp);
        cache.ix = Math.round(focus.dot(cache.right) / texel); cache.iy = Math.round(focus.dot(cache.up) / texel);
        cache.sun.copy(this.sunDir);
        cache.cam.copy(cullCamera.position);
        world.cullShadow(this.lightCamera, cullCamera);
        // The sky dome is on its own layer, which the light camera doesn't see.
        profiler.group('shadow map', () => {
          scene.overrideMaterial = this.depthMaterial;
          this.drawLayers('shadow map', scene, this.lightCamera, world, this.shadowTarget);
          scene.overrideMaterial = null;
        });
      }
      this.shadowAllocated = true;
    } else if (!this.shadowAllocated) {
      r.setRenderTarget(this.shadowTarget);
      r.clear();
      this.shadowAllocated = true;
    }

    // Far-LOD sprites look the shadow map up themselves (before the scene is drawn, unlike the post uniforms below).
    const shade = this.env.spriteShade;
    const sunShare = (lum(this.env.sunColor) * 0.85 * 0.6) / (lum(this.env.skyAmbient) * 0.8 + lum(this.env.groundAmbient) * 0.2 + lum(this.env.sunColor) * 0.85 * 0.6);
    shade.spriteShadow.value = sunFactor > 0.001 && shadowsInRange ? sunShare * sunFactor : 0;
    shade.spriteAO.value = 0.4 + 0.6 * sunFactor;
    shade.tShadow.value = this.shadowTarget.depthTexture;
    shade.shadowVP.value.multiplyMatrices(this.lightCamera.projectionMatrix, this.lightCamera.matrixWorldInverse);
    shade.focus.value.copy(focus);
    shade.regionR.value = region;
    shade.shadowRange.value = this.lightCamera.far - this.lightCamera.near;

    // 2. Main view into the HDR target.
    const stats = world.cull(cullCamera);
    profiler.group('scene (HDR)', () => this.drawMain(scene, camera, world));

    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const u = this.postMaterial.uniforms;
    u.viewProj.value.copy(this.viewProj);
    u.invViewProj.value.copy(this.viewProj).invert();

    // 3. Deferred local lights: culled light volumes accumulate irradiance from the scene depth.
    const field = world.lights;
    const lu = field.uniforms;
    lu.tDepth.value = this.sceneTarget.depthTexture;
    lu.invViewProj.value.copy(u.invViewProj.value);
    lu.resolution.value.copy(this.size);
    (lu.lightResolution.value as THREE.Vector2).set(this.lightTarget.width, this.lightTarget.height);
    const lightsDrawn = profiler.scope('cull', 'light volumes', () => field.cull(cullCamera));
    profiler.count('lights', 'light volumes drawn', lightsDrawn);
    if (lightsDrawn > 0 || !this.lightAllocated) {
      profiler.pass('local lights', () => {
        r.setRenderTarget(this.lightTarget);
        r.clear();
        if (lightsDrawn > 0) r.render(field.scene, camera);
      });
      this.lightAllocated = true;
    }
    u.lightOn.value = lightsDrawn > 0 ? 1 : 0;
    (u.lightSize.value as THREE.Vector2).set(this.lightTarget.width, this.lightTarget.height);

    // 3b. Light rays: a half-resolution march through the beams, using the same scene depth.
    lu.tNoise.value = u.tNoise.value;
    lu.rayResolution.value.set(this.rayTarget.width, this.rayTarget.height);
    // Wet-street reflections of the lights go into the same target (both are added as is).
    const raysDrawn = profiler.scope('cull', 'light shafts', () => field.cullShafts(cullCamera));
    const reflectionsDrawn = profiler.scope('cull', 'wet reflections', () => field.cullReflections(cullCamera));
    profiler.count('lights', 'light shafts drawn', raysDrawn);
    profiler.count('lights', 'reflection groups drawn', reflectionsDrawn);
    if (raysDrawn > 0 || reflectionsDrawn > 0 || !this.rayAllocated) {
      profiler.pass('light rays + reflections', () => {
        r.setRenderTarget(this.rayTarget);
        r.clear();
        const autoClear = r.autoClear;
        r.autoClear = false;
        if (raysDrawn > 0) r.render(field.shaftScene, camera);
        if (reflectionsDrawn > 0) r.render(field.reflectScene, camera);
        r.autoClear = autoClear;
      });
      this.rayAllocated = true;
    }
    u.rayOn.value = raysDrawn > 0 || reflectionsDrawn > 0 ? 1 : 0;

    // 4. Shadows + occlusion + local lights + output conversion.
    u.shadowVP.value.multiplyMatrices(this.lightCamera.projectionMatrix, this.lightCamera.matrixWorldInverse);
    u.focus.value.copy(focus);
    u.camPos.value.copy(camera.position);
    u.regionR.value = region;
    u.fogNear.value = lu.fogNear.value; // map-edge haze range (World.update): shadows / AO fade out inside it
    u.fogFar.value = lu.fogFar.value;
    u.fogOrigin = lu.fogOrigin; // game camera, shared with the map materials
    u.resolution.value.copy(this.size);
    u.pxScale.value = this.size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.camNear.value = camera.near;
    u.camFar.value = camera.far;
    u.texelWorld.value = (2 * (this.shadowCache.region || region)) / this.shadowSize; // of the map as drawn (none drawn yet: this frame's)
    u.shadowRange.value = this.lightCamera.far - this.lightCamera.near;
    u.shadowStrength.value = sunFactor;
    u.debugView.value = DEBUG_SHADER_ID[this.debugView];
    u.sunLum.value = lum(this.env.sunColor) * 0.85;
    u.ambLum.value = lum(this.env.skyAmbient) * 0.8 + lum(this.env.groundAmbient) * 0.2;
    u.aoStrength.value = 0.4 + 0.6 * sunFactor; // occlusion stays, but softer, at night
    u.aoOn.value = this.grouped('ambient occlusion', () => this.renderAO(camera, focus, region)) ? 1 : 0;

    // 5. Bloom and god rays from the HDR scene (before shadows: they only take light brighter than lit surfaces / the sky).
    const bloom = this.grouped('bloom', () => this.bloom.render(r, this.passFn, this.sceneTarget.texture));
    u.tBloom.value = bloom;
    u.bloomStrength.value = bloom ? BLOOM_STRENGTH : 0;
    const god = this.grouped('god rays', () => this.godRays.render(this.passFn, this.sceneTarget.texture, this.sceneTarget.depthTexture!, this.viewProj, camera.position, this.sunDir, THREE.MathUtils.smoothstep(this.sunDir.y, -0.02, 0.06), camera.aspect));
    u.tGod.value = god;
    u.godOn.value = god ? 1 : 0;

    profiler.scope('render', 'grade LUT bake', () => this.gradeLut.bake(this.env.daylight.value));
    this.postQuad.material = this.postMaterial;
    this.drawPost();
    this.finish(distance);
    return stats;
  }

  /** Runs `fn` as the profiler pass `name`; the full-screen passes inside it show up as its parts in detail mode. */
  private grouped<T>(name: string, fn: () => T): T {
    this.group = name;
    try {
      return profiler.group(name, fn);
    } finally {
      this.group = '';
    }
  }

  /**
   * Draws `scene` from `camera` into `target`. In the profiler's detail mode it is drawn layer by layer (ground, roads,
   * trees, buildings, lights, sky...) into the same target, cleared once, so every layer gets its own GPU time, draw calls
   * and triangles. Each separate render of a multisampled target also resolves it, so the last part, `overhead`, is an empty
   * render: its time is included in every other part.
   */
  /** The main view into the scene target: normal layers, or one of the triangle debug views. */
  private drawMain(scene: THREE.Scene, camera: THREE.Camera, world: World): void {
    if (this.debugView === 'wire') {
      this.drawWire(scene, camera, world, true);
      return;
    }
    this.drawLayers('scene (HDR)', scene, camera, world, this.sceneTarget);
    if (this.debugView === 'overlay') this.drawWire(scene, camera, world, false);
  }

  /** Redraws the culled map meshes as triangle outlines; `fill`: first clears to a dark fill so only visible edges show. */
  private drawWire(scene: THREE.Scene, camera: THREE.Camera, world: World, fill: boolean): void {
    const r = this.renderer;
    // The sky dome, halos and overlay quads aren't part of the map's triangles.
    const hidden = scene.children.filter((c) => !(c as THREE.Light).isLight && c !== world.group && c.visible);
    for (const o of hidden) o.visible = false;
    const background = scene.background;
    const clearColor = r.getClearColor(new THREE.Color());
    const clearAlpha = r.getClearAlpha();
    const autoClear = r.autoClear;
    scene.background = null;
    try {
      r.setRenderTarget(this.sceneTarget);
      if (fill) {
        r.setClearColor(0x06080b, 1);
        r.autoClear = true;
        scene.overrideMaterial = this.wireFill;
        r.render(scene, camera);
      }
      r.autoClear = false;
      scene.overrideMaterial = this.wireLine;
      r.render(scene, camera);
    } finally {
      scene.overrideMaterial = null;
      scene.background = background;
      r.setClearColor(clearColor, clearAlpha);
      r.autoClear = autoClear;
      for (const o of hidden) o.visible = true;
    }
  }

  private drawLayers(group: string, scene: THREE.Scene, camera: THREE.Camera, world: World, target: THREE.WebGLRenderTarget): void {
    const r = this.renderer;
    r.setRenderTarget(target);
    if (!profiler.detailed) {
      r.render(scene, camera);
      return;
    }
    const layers = world.layerGroups();
    const halos = world.lights.haloGroup;
    const quads = world.lights.fakeGroup;
    // Everything else at the top of the scene (sky dome...) except the lights, which every material needs.
    const other = scene.children.filter((c) => !(c as THREE.Light).isLight && c !== world.group && c !== halos && c !== quads);
    const parts: { name: string; objects: THREE.Object3D[] }[] = [
      ...layers.map((l) => ({ name: l.name, objects: [l.object] })),
      { name: 'light halos', objects: [halos] },
      { name: 'light overlay quads', objects: [quads] },
      { name: 'sky + other', objects: other },
      { name: 'overhead (empty render)', objects: [] },
    ];
    const toggled = [...layers.map((l) => l.object), halos, quads, ...other];
    const was = new Map(toggled.map((o) => [o, o.visible]));
    const autoClear = r.autoClear;
    r.clear(); // colour and depth of the target, once
    r.autoClear = false;
    try {
      for (const part of parts) {
        if (part.objects.length && !part.objects.some((o) => was.get(o))) continue; // hidden anyway (e.g. overlay quads with deferred lights)
        for (const o of toggled) o.visible = part.objects.includes(o) && was.get(o)!;
        profiler.part(group, part.name, () => r.render(scene, camera));
      }
    } finally {
      for (const [o, v] of was) o.visible = v;
      r.autoClear = autoClear;
    }
  }

  /**
   * The post pass. In detail mode some frames (one in ~30 per feature) run it with a feature switched off, as a separate
   * pass `post without: <feature>`: the report shows what each feature costs (A/B on the same frame content).
   */
  private drawPost(): void {
    const r = this.renderer;
    const u = this.postMaterial.uniforms;
    let name = POST_PASS;
    let restore: (() => void) | null = null;
    if (profiler.detailed) {
      const k = (this.probeFrame++ % PROBE_CYCLE);
      const variant = k % 6 === 2 ? Math.floor(k / 6) : -1; // frames 2, 8, 14, 20, 26 of 30
      if (variant >= 0) {
        const saved = { shadow: u.shadowStrength.value, contact: u.contactSteps.value, ao: u.aoOn.value, light: u.lightOn.value, bloom: u.bloomStrength.value, ray: u.rayOn.value, god: u.godOn.value };
        restore = () => {
          u.shadowStrength.value = saved.shadow;
          u.contactSteps.value = saved.contact;
          u.aoOn.value = saved.ao;
          u.lightOn.value = saved.light;
          u.bloomStrength.value = saved.bloom;
          u.rayOn.value = saved.ray;
          u.godOn.value = saved.god;
        };
        if (variant === 0) { name = `${ABLATION}sun shadows (map + contact)`; u.shadowStrength.value = 0; }
        else if (variant === 1) { name = `${ABLATION}contact shadows`; u.contactSteps.value = 0; }
        else if (variant === 2) { name = `${ABLATION}ambient occlusion`; u.aoOn.value = 0; }
        else if (variant === 3) { name = `${ABLATION}local lights`; u.lightOn.value = 0; }
        else { name = `${ABLATION}bloom + rays + god rays`; u.bloomStrength.value = 0; u.rayOn.value = 0; u.godOn.value = 0; }
      }
    }
    profiler.pass(name, () => {
      r.setRenderTarget(this.ldrTarget);
      r.render(this.postScene, this.postCamera);
    });
    restore?.();
  }

  /** Half-resolution ambient occlusion: depth downsample, occlusion, blur. Returns false when off. */
  private renderAO(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, region: number): boolean {
    const ao = this.aoMaterial;
    if (!ao) return false;
    const size = new THREE.Vector2(this.zTarget.width, this.zTarget.height);
    const du = this.aoDepthMaterial.uniforms;
    du.tDepth.value = this.sceneTarget.depthTexture;
    du.camNear.value = camera.near;
    du.camFar.value = camera.far;
    this.pass(this.aoDepthMaterial, this.zTarget);

    const au = ao.uniforms;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    au.size.value.copy(size);
    au.projScale.value.set(tan * camera.aspect, tan);
    au.pxScale.value = size.y / (2 * tan);
    au.viewToWorld.value.copy(camera.matrixWorld);
    au.focus.value.copy(focus);
    au.regionR.value = region;
    this.pass(ao, this.aoTarget);

    this.aoBlurMaterial.uniforms.size.value.copy(size);
    this.pass(this.aoBlurMaterial, this.aoBlurTarget);
    this.postMaterial.uniforms.aoSize.value.copy(size);
    return true;
  }

  /** One full-screen pass of `material` into `target`. */
  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.postQuad.material = material;
    // In the profiler's detail mode each one is timed on its own (`<group>: <material name>`, see `grouped`).
    profiler.part(this.group, material.name || 'pass', () => {
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.postScene, this.postCamera);
    });
  }

  /** Orthographic sun camera covering `region` around the focus, snapped to shadow-map texels so shadows don't shimmer while panning. */
  private updateLightCamera(cam: THREE.OrthographicCamera, focus: THREE.Vector3, region: number): void {
    const texel = (2 * region) / this.shadowSize;
    // Light-space screen axes; they change with the sun, so rebuild them every frame.
    this.basisCamera.position.copy(this.sunDir);
    this.basisCamera.lookAt(0, 0, 0);
    this.basisCamera.updateMatrixWorld();
    this.lightRight.setFromMatrixColumn(this.basisCamera.matrixWorld, 0);
    this.lightUp.setFromMatrixColumn(this.basisCamera.matrixWorld, 1);
    const c = this.tmp.copy(focus);
    const sx = Math.round(c.dot(this.lightRight) / texel) * texel - c.dot(this.lightRight);
    const sy = Math.round(c.dot(this.lightUp) / texel) * texel - c.dot(this.lightUp);
    c.addScaledVector(this.lightRight, sx).addScaledVector(this.lightUp, sy);

    const dist = region + LIGHT_HEIGHT;
    cam.left = -region;
    cam.right = region;
    cam.top = region;
    cam.bottom = -region;
    cam.near = 1;
    cam.far = dist + region + 100;
    cam.position.copy(c).addScaledVector(this.sunDir, dist);
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}

/** Full-screen material for one AO pass (ao.frag.glsl, selected by `pass` define). */
function aoPass(pass: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: pass.replace('PASS_', '').toLowerCase(), // pass name in the profiler report
    vertexShader: postVertex,
    fragmentShader: aoFragment,
    defines: { [pass]: '', ...defines },
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}
