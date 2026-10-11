import * as THREE from 'three';
import { type BuildingState, type GenEvent, type Side, type Terrain, type TerrainMeta, type TreeType } from './terrain/generate.ts';
import { TerrainGenerator } from './terrain/generator.ts';
import { World, type Environment, type TerrainTextures } from './render/world.ts';
import { RTSCameraController, type CameraView } from './render/rtsCamera.ts';
import { Lighting } from './render/lighting.ts';
import { applyTimeOfDay, DEFAULT_HOUR, goldenHour } from './render/timeOfDay.ts';
import { Atmosphere } from './render/atmosphere.ts';
import { Sky, SKY_LAYER } from './render/sky.ts';
import { DEFAULT_QUALITY, QUALITY_SETTINGS, type Quality } from './render/quality.ts';
import type { DebugView } from './render/debugView.ts';
import { createSpriteShade } from './render/billboard.ts';
import { profiler } from './core/profiler.ts';
import { GpuTimer } from './render/gpuTimer.ts';
import { DynamicResolution } from './render/dynamicResolution.ts';

// Map size comes from the one scale constant (terrain/scale.ts: MAP_SCALE).
export { MAP_CELL, MAP_SIZE } from './terrain/scale.ts';
import { MAP_CELL, MAP_SIZE } from './terrain/scale.ts';

const TEXTURE_BASE = `${import.meta.env.BASE_URL}assets/textures/`;
/** Main-thread time per frame spent building map meshes while a map streams in (ms). */
const BUILD_BUDGET_MS = 6;
/** Sun movement (radians, ~0.6 deg) that makes the far-LOD sprites bake their shading again. */
const SPRITE_REBAKE_STEP = 0.01;
/** Sun / moon movement (radians, ~0.3 deg) that makes the sky and aerial-perspective LUTs bake again. */
const ATMOSPHERE_REBAKE_STEP = 0.005;

/** Plain summary returned to the UI (no heavy arrays -> safe for Alpine reactivity). */
export interface MapInfo {
  seed: number;
  size: number;
  seaSides: Side[];
  mountainSides: Side[];
  riverCount: number;
  tributaries: number;
  rockCount: number;
  /** Player bases: build-area side length (m) and closest distance between two bases (m). */
  baseSize: number;
  baseGap: number;
  treeType: TreeType;
  treeCount: number;
  /** Share of land that is bare dirt, percent. */
  dirtPercent: number;
  /** Road lengths in km (1 world unit = 1 m). */
  roadKm: number;
  asphaltKm: number;
  /** Railway length in km (0 = no railway) and its level crossings with roads. */
  railKm: number;
  levelCrossings: number;
  /** Road and railway bridges. */
  bridges: number;
  junctions: number;
  /** Towns, buildings (all / in towns / abandoned / unfinished construction sites). */
  cityCount: number;
  buildingCount: number;
  cityBuildings: number;
  abandoned: number;
  construction: number;
  /** Power plants, substations, high-voltage pylons and utility poles. */
  plantCount: number;
  substationCount: number;
  pylonCount: number;
  poleCount: number;
  landPercent: number;
  genMs: number;
  /** From the first map piece reaching the renderer (the first meshes get built) until the very last item is built; overlaps generation, which streams. */
  loadMs: number;
}

/** Map loading state for the UI: what is happening and how far along (0..1). */
export interface LoadProgress {
  label: string;
  fraction: number;
}

export interface FrameStats {
  fps: number;
  /** Dynamic resolution share of the preset's pixel ratio (1 = full). */
  scale: number;
  /** Chunk meshes drawn / total after frustum culling. */
  drawn: number;
  total: number;
  /** Draw calls and triangles submitted in the last frame (every pass: shadows, lights, post). */
  calls: number;
  triangles: number;
}

export class Engine {
  /** Called twice a second: frame rate and how many map chunks were drawn last frame. */
  onStats: (stats: FrameStats) => void = () => {};
  /** Called every frame while a map loads, then once with null when it is complete. */
  onProgress: (progress: LoadProgress | null) => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private container: HTMLElement;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controller: RTSCameraController;
  /** Debug freeze: the game camera (culling, LOD, shadows) stays here while `camera` flies free. */
  private frozen: { camera: THREE.PerspectiveCamera; focus: THREE.Vector3; distance: number; helper: THREE.CameraHelper } | null = null;
  private debugScene = new THREE.Scene();
  private world: World | null = null;
  private lighting: Lighting | null = null;
  private env: Environment;
  /** Baked sky / aerial perspective LUTs (rebaked when the time of day changes). */
  private atmosphere: Atmosphere;
  private sky: Sky;
  private sunLight = new THREE.DirectionalLight(0xffffff, 1.6);
  private skyLight = new THREE.HemisphereLight(0xbcd4e6, 0x4a4030, 1.0);
  private hour = DEFAULT_HOUR;
  private level: Quality;
  private textures: TerrainTextures | null = null;
  private ready: Promise<void>;
  private timer = new THREE.Timer();
  private pendingView: CameraView | null = null;
  private generator = new TerrainGenerator();
  private lastFrameAt = 0;
  /** Sun direction and daylight of the last sprite re-bake request (see `timeOfDay`). */
  private spriteSun = new THREE.Vector3(0, -1, 0);
  private spriteDaylight = -1;
  /** Sun / moon of the last atmosphere LUT bake (see `timeOfDay`). */
  private bakedSun = new THREE.Vector3(0, -1, 0);
  private bakedMoon = new THREE.Vector3(0, -1, 0);
  private bakedMoonLit = -1;
  /** Dynamic resolution scale to apply at the start of the next frame (see `frameLoop`). */
  private pendingScale: number | null = null;
  /** A map has been started (the camera has been placed). */
  private hasMap = false;
  /** Lowers the render resolution while the GPU can't hold the frame rate (high / ultra, see QualitySettings.dynamicResolution). */
  private dynamicRes = new DynamicResolution();
  /** Generator stage in progress (for the profiler's stage timings). */
  private genStage: { name: string; at: number } | null = null;
  /** Loading state: generator stage, then build progress once generation is done. */
  private loading: { label: string; genFraction: number; generated: boolean; maxPending: number; meshStart: number } | null = null;

  constructor(container: HTMLElement, quality: Quality = DEFAULT_QUALITY) {
    this.level = quality;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }) // MSAA happens in the scene render target (see Lighting);
    this.renderer.setPixelRatio(pixelRatioFor(quality));
    container.appendChild(this.renderer.domElement);
    this.container = container;
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.setupProfiler();

    this.atmosphere = new Atmosphere(this.renderer);

    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 1, 4000);
    this.camera.layers.enable(SKY_LAYER);
    this.controller = new RTSCameraController(this.camera, this.renderer.domElement, {
      heightAt: (x, z) => this.world?.heightAt(x, z) ?? 0,
      bound: ((MAP_SIZE - 1) * MAP_CELL) / 2,
    });

    // Shared lighting environment: shaders keep references to these objects, applyTimeOfDay mutates them in place.
    this.env = {
      sunDir: new THREE.Vector3(),
      sunColor: new THREE.Color(),
      skyAmbient: new THREE.Color(),
      groundAmbient: new THREE.Color(),
      moonDir: new THREE.Vector3(),
      moonLit: { value: 1 },
      starRotation: new THREE.Matrix3(),
      fog: this.atmosphere.fog,
      spriteShade: createSpriteShade(),
      daylight: { value: 1 },
      hour: { value: DEFAULT_HOUR },
    };
    this.sky = new Sky(this.atmosphere, this.env);
    // The Lambert-lit map skirt uses these scene lights; every other shader reads the environment.
    this.scene.add(this.sunLight, this.skyLight, this.sky.mesh);
    // Every map mesh has an identity transform (see culling.ts) and the camera is updated by the renderer: only the two
    // scene lights ever move. Skipping three.js' per-render world-matrix pass over thousands of objects is a big CPU win.
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.updateMatrixWorld(true);
    this.timeOfDay = DEFAULT_HOUR;

    this.ready = loadTextures().then((textures) => {
      this.textures = textures;
      this.world = new World(textures, this.env, this.renderer);
      this.lighting = new Lighting(this.renderer, this.env, QUALITY_SETTINGS[this.level], textures.shadowNoise);
      this.scene.add(this.world.group, this.world.lights.fakeGroup, this.world.lights.haloGroup);
      this.applyQuality();
    });

    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(this.frameLoop());
  }

  /**
   * Hooks the profiler (core/profiler.ts) up to this renderer: GPU timer queries, per-pass draw call counts and the
   * environment lines of its report. three.js resets its counters on every render() call by default; they are reset once
   * per frame instead, so a pass can be measured as the difference around it.
   */
  private setupProfiler(): void {
    const r = this.renderer;
    r.info.autoReset = false;
    const gpu = new GpuTimer(r.getContext() as WebGL2RenderingContext);
    profiler.attachGpu(gpu);
    profiler.attachInfo(() => ({
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
      programs: r.info.programs?.length ?? 0,
    }));
    profiler.addContext(() => {
      const q = QUALITY_SETTINGS[this.level];
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const v = this.controller.view;
      const t = this.world?.terrain;
      const nav = navigator as Navigator & { deviceMemory?: number };
      const ctx: Record<string, string> = {
        gpu: gpu.gpuName(),
        browser: navigator.userAgent,
        'cpu threads': String(navigator.hardwareConcurrency ?? '?'),
        'device memory': nav.deviceMemory ? `${nav.deviceMemory} GB` : '?',
        quality: this.level,
        'quality settings': JSON.stringify(q),
        'drawing buffer': `${size.x}x${size.y} px (pixel ratio ${r.getPixelRatio().toFixed(2)}, dpr ${devicePixelRatio}, dynamic resolution ${Math.round(this.dynamicRes.scale * 100)}%)`,
        hour: this.hour.toFixed(2),
        camera: `focus ${v.x.toFixed(0)},${v.z.toFixed(0)} yaw ${v.yaw.toFixed(2)} pitch ${v.pitch.toFixed(2)} distance ${v.distance.toFixed(0)}${this.frozen ? ' (frozen)' : ''}`,
        'map state': this.loading ? `loading (${this.loading.label})` : t ? 'built' : 'none',
        'queued build jobs': String(this.world?.pending ?? 0),
        'renderer memory': `${r.info.memory.geometries} geometries, ${r.info.memory.textures} textures, ${r.info.programs?.length ?? 0} shader programs`,
      };
      if (t) {
        ctx.map = `seed ${t.seed}, ${t.buildings.length} buildings, ${t.trees.trees.length} trees (${t.trees.type}), ${t.rocks.length} rocks, ${t.roads.edges.length} road edges, ${t.cities.length} towns`;
      }
      return ctx;
    });
  }

  /** Hour of the day, 0-24 (fractional). Night (sun below the horizon) has no shadows. */
  get timeOfDay(): number {
    return this.hour;
  }
  set timeOfDay(hour: number) {
    this.hour = hour;
    const { daylight } = profiler.scope('time of day', 'apply', () => applyTimeOfDay(hour, this.env));
    // The sky / aerial LUTs (65 draw calls) are rebaked only once the sun or moon moved visibly since the last bake.
    const { sunDir, moonDir, moonLit } = this.env;
    if (
      this.bakedSun.dot(sunDir) < Math.cos(ATMOSPHERE_REBAKE_STEP) || this.bakedMoon.dot(moonDir) < Math.cos(ATMOSPHERE_REBAKE_STEP)
      || Math.abs(this.bakedMoonLit - moonLit.value) > 0.02
    ) {
      this.bakedSun.copy(sunDir);
      this.bakedMoon.copy(moonDir);
      this.bakedMoonLit = moonLit.value;
      profiler.scope('time of day', 'atmosphere bake (sky + aerial LUTs)', () => this.atmosphere.bake(sunDir, moonDir, moonLit.value, goldenHour(sunDir.y)));
    }
    this.sunLight.position.copy(this.env.sunDir).multiplyScalar(100);
    this.sunLight.updateMatrixWorld(); // the scene's automatic matrix update is off (see the constructor)
    this.sunLight.color.copy(this.env.sunColor);
    this.skyLight.intensity = 0.1 + 0.9 * daylight;
    // Sprites carry baked shading: re-baked (a column per frame, see World.update) only once the light changed visibly.
    if (this.spriteSun.dot(this.env.sunDir) < Math.cos(SPRITE_REBAKE_STEP) || Math.abs(this.spriteDaylight - daylight) > 0.02) {
      this.spriteSun.copy(this.env.sunDir);
      this.spriteDaylight = daylight;
      this.world?.refreshSprites();
    }
  }

  /** Graphics quality preset (see render/quality.ts): resolution, shadows / occlusion, light and billboard distances... */
  get quality(): Quality {
    return this.level;
  }
  set quality(level: Quality) {
    this.level = level;
    profiler.note(`quality set to ${level}`);
    profiler.scope('quality', 'apply preset', () => this.applyQuality());
  }

  /** Debug view of the render pipeline (triangles, AO, shadows...); `final` is the normal image. Not persisted. */
  get debugView(): DebugView {
    return this.lighting?.debugView ?? 'final';
  }
  set debugView(view: DebugView) {
    if (this.lighting) this.lighting.debugView = view;
    this.world?.setLodDebug(view === 'lod');
  }

  private applyQuality(): void {
    const q = QUALITY_SETTINGS[this.level];
    this.dynamicRes.reset();
    this.renderer.setPixelRatio(pixelRatioFor(this.level)); // also resizes the drawing buffer
    this.lighting?.setQuality(q);
    this.world?.setQuality(q);
    if (this.textures) {
      const maxAniso = Math.min(q.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
      for (const [name, tex] of Object.entries(this.textures)) {
        if (name === 'shadowNoise') continue;
        // Full anisotropy only where long grazing views show it (ground, roads); noisy / rarely grazing textures need less.
        const anisotropy = Math.max(1, Math.min(maxAniso, ANISO_CAP[name] ?? maxAniso));
        if (tex.anisotropy === anisotropy) continue;
        tex.anisotropy = anisotropy;
        tex.needsUpdate = true;
      }
    }
  }

  /**
   * Debug: freezes the game camera where it is. Culling, LOD, shadows, lights and effects keep using the frozen camera
   * while the camera controls fly a free debug camera that sees the result; the frozen frustum is drawn as lines.
   * Unfreezing returns to normal (the free camera becomes the game camera again).
   */
  get cameraFrozen(): boolean {
    return this.frozen !== null;
  }
  set cameraFrozen(on: boolean) {
    if (on === (this.frozen !== null)) return;
    if (on) {
      const camera = this.camera.clone();
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      const helper = new THREE.CameraHelper(camera);
      helper.update();
      const material = helper.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.transparent = true;
      this.debugScene.add(helper);
      this.frozen = { camera, focus: this.controller.target.clone(), distance: this.controller.distance, helper };
    } else if (this.frozen) {
      this.debugScene.remove(this.frozen.helper);
      this.frozen.helper.dispose();
      this.frozen = null;
    }
  }

  /** Camera focus / rotation / zoom. Set before the first map is built, it becomes that map's starting view. */
  get cameraView(): CameraView {
    return this.pendingView ?? this.controller.view;
  }
  set cameraView(view: CameraView) {
    if (this.hasMap) this.controller.view = view;
    else this.pendingView = view;
  }

  /**
   * Destroyed bits of the current map's buildings (one per Terrain.buildings entry); null until the map's buildings
   * are known. Gameplay / network code flips bits here and the map shows rubble at once.
   */
  get buildingState(): BuildingState | null {
    return this.world?.buildingState ?? null;
  }

  /** Current map data (heights, roads graph, rocks...) for gameplay / AI. */
  get terrain(): Terrain | null {
    return this.world?.terrain ?? null;
  }

  /**
   * Generates and shows a map. Generation runs in a worker and streams into the render pipeline: the map builds
   * up on screen stage by stage (see `onProgress`); resolves with its summary once everything is built.
   */
  async generate(seed: number): Promise<MapInfo> {
    // The worker starts at once; events wait for the world (textures) on the first map.
    const world = this.ready.then(() => this.world!);
    this.loading = { label: 'Generating', genFraction: 0, generated: false, maxPending: 0, meshStart: 0 };
    const loading = this.loading;
    try {
      const { ms } = await this.generator.generate(seed, { size: MAP_SIZE, cell: MAP_CELL }, (event) => {
        world.then((w) => this.handle(w, event)).catch(() => {}); // a failed world surfaces below
      });
      this.loading.generated = true;
      const w = await world;
      await w.whenBuilt();
      const loadMs = loading.meshStart ? performance.now() - loading.meshStart : 0;
      return mapInfo(w.terrain!, ms, loadMs);
    } finally {
      this.loading = null;
      this.onProgress(null);
    }
  }

  private handle(world: World, event: GenEvent): void {
    if (event.kind === 'meta') this.placeCamera(event.meta);
    // The first heights are the first mesh work: loading is timed from here.
    if (event.kind === 'heights' && this.loading && !this.loading.meshStart) this.loading.meshStart = performance.now();
    if (event.kind === 'stage' && this.loading) {
      // Generator stage wall time = time between two stage events (worker time + message latency).
      const now = performance.now();
      if (this.genStage) profiler.sample('generation', `stage ${this.genStage.name}`, now - this.genStage.at);
      this.genStage = { name: event.stage, at: now };
      this.loading.label = `Generating ${event.stage}`;
      this.loading.genFraction = event.index / event.count;
    }
    if (event.kind === 'done') {
      if (this.genStage) profiler.sample('generation', `stage ${this.genStage.name}`, performance.now() - this.genStage.at);
      this.genStage = null;
    }
    // Main-thread cost of taking an event in (storing data, queueing build jobs); the meshes are built later, in `build/*`.
    profiler.scope('generation', `handle ${event.kind} event`, () => world.push(event));
  }

  /** Camera bounds for a new map; the view carries over between maps (the first map starts at the restored or default view). */
  private placeCamera(meta: TerrainMeta): void {
    this.controller.bound = meta.playSize / 2;
    if (!this.hasMap && this.pendingView) this.controller.view = this.pendingView;
    else if (!this.hasMap) this.controller.reset();
    else this.controller.view = this.controller.view; // re-clamp; the focus follows the ground as it streams in
    this.pendingView = null;
    this.hasMap = true;
  }

  private reportProgress(): void {
    const l = this.loading;
    if (!l) return;
    const pending = this.world?.pending ?? 0;
    l.maxPending = Math.max(l.maxPending, pending);
    if (!l.generated) this.onProgress({ label: l.label, fraction: 0.6 * l.genFraction });
    else this.onProgress({ label: 'Building map', fraction: 0.6 + 0.4 * (l.maxPending ? 1 - pending / l.maxPending : 1) });
  }

  /** Applies a new dynamic resolution share: pixel ratio (drawing buffer) and every render target follow. */
  private applyResolutionScale(scale: number): void {
    profiler.note(`dynamic resolution ${Math.round(scale * 100)}%`);
    this.renderer.setPixelRatio(pixelRatioFor(this.level, scale));
    this.lighting?.resize();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.lighting?.resize();
  }

  private screenshotCallback: ((dataUrl: string) => void) | null = null;

  /** Resolves with the next finished frame as a PNG data URL. */
  screenshot(): Promise<string> {
    return new Promise((resolve) => {
      this.screenshotCallback = resolve;
    });
  }

  private frameLoop(): (time: number) => void {
    let frames = 0;
    let acc = 0;
    return (time) => {
      const frameStart = performance.now();
      if (this.pendingScale !== null) {
        this.applyResolutionScale(this.pendingScale);
        this.pendingScale = null;
      }
      profiler.beginFrame();
      this.renderer.info.reset(); // counters are per frame (autoReset is off, see setupProfiler)
      this.timer.update(time);
      const dt = Math.min(this.timer.getDelta(), 0.1);
      profiler.scope('frame', 'camera controller', () => this.controller.update(dt));
      const focus = this.frozen?.focus ?? this.controller.target;
      const distance = this.frozen?.distance ?? this.controller.distance;
      profiler.scope('build', 'world.step (jobs + scene sync)', () => this.world?.step(BUILD_BUDGET_MS, focus));
      profiler.scope('frame', 'progress report (UI callback)', () => this.reportProgress());
      profiler.scope('update', 'world.update (uniforms, lamps)', () => this.world?.update(this.timer.getElapsed(), this.frozen?.camera ?? this.camera));
      profiler.scope('update', 'sky.update', () => this.sky.update(this.timer.getElapsed()));
      let cull = { drawn: 0, total: 0 };
      if (this.world && this.lighting) {
        cull = this.lighting.render(this.scene, this.camera, this.world, focus, distance, this.frozen?.camera ?? this.camera);
        if (this.frozen) {
          // Frustum lines of the frozen game camera, over everything (no depth test).
          profiler.pass('debug overlay', () => {
            const autoClear = this.renderer.autoClear;
            this.renderer.autoClear = false;
            this.renderer.setRenderTarget(null);
            this.renderer.render(this.debugScene, this.camera);
            this.renderer.autoClear = autoClear;
          });
        }
        if (profiler.isRecording) {
          profiler.count('culling', 'chunk meshes drawn', cull.drawn);
          profiler.count('culling', 'chunk meshes registered', cull.total);
          profiler.count('draw calls', 'frame total', this.renderer.info.render.calls);
          profiler.count('triangles', 'frame total', this.renderer.info.render.triangles);
        }
      }
      profiler.endFrame();

      // Screenshot request (command line capture in the Tauri app): the drawing buffer is only valid right after the draw.
      if (this.screenshotCallback) {
        const done = this.screenshotCallback;
        this.screenshotCallback = null;
        done(this.renderer.domElement.toDataURL('image/png'));
      }

      // Dynamic resolution: wall time of this frame (clamped dt would hide stalls) and the main-thread share of it.
      const cpuMs = performance.now() - frameStart;
      const wallMs = this.lastFrameAt ? frameStart - this.lastFrameAt : cpuMs;
      this.lastFrameAt = frameStart;
      const scale = this.dynamicRes.update(wallMs, cpuMs, frameStart / 1000, QUALITY_SETTINGS[this.level].dynamicResolution);
      // Applied at the start of the next frame: resizing the canvas after this frame was drawn would clear it before it is presented.
      if (scale !== null) this.pendingScale = scale;

      frames++;
      acc += dt;
      if (acc >= 0.5) {
        this.onStats({ fps: Math.round(frames / acc), scale: this.dynamicRes.scale, ...cull, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles });
        frames = 0;
        acc = 0;
      }
    };
  }
}

/** Rendered pixels per CSS pixel: the display ratio up to the preset's cap, times its render scale (and the dynamic resolution share). */
function pixelRatioFor(level: Quality, dynamicScale = 1): number {
  const q = QUALITY_SETTINGS[level];
  return Math.min(window.devicePixelRatio, q.pixelRatioCap) * q.renderScale * dynamicScale;
}

/** Plain summary of a finished map for the UI. */
function mapInfo(terrain: Terrain, genMs: number, loadMs: number): MapInfo {
  const { edges, nodes } = terrain.roads;
  const km = (list: typeof edges) => Math.round(list.reduce((s, e) => s + e.length, 0) / 100) / 10;
  return {
    seed: terrain.seed,
    size: terrain.play.i1 - terrain.play.i0 + 1,
    seaSides: terrain.seaSides,
    mountainSides: terrain.mountainSides,
    riverCount: terrain.rivers.length,
    tributaries: terrain.rivers.filter((r) => r.tributary).length,
    rockCount: terrain.rocks.length,
    baseSize: terrain.bases[0]?.size ?? 0,
    baseGap: closestBases(terrain),
    treeType: terrain.trees.type,
    treeCount: terrain.trees.trees.length,
    dirtPercent: dirtPercent(terrain),
    roadKm: km(edges.filter((e) => e.type !== 'rail')),
    asphaltKm: km(edges.filter((e) => e.type === 'asphalt')),
    railKm: km(edges.filter((e) => e.type === 'rail')),
    levelCrossings: nodes.filter((n) => n.kind === 'crossing').length,
    bridges: edges.reduce((s, e) => s + e.bridges.length, 0),
    junctions: nodes.filter((n) => n.kind === 'junction').length,
    cityCount: terrain.cities.length,
    buildingCount: terrain.buildings.length,
    cityBuildings: terrain.buildings.filter((b) => b.city >= 0).length,
    abandoned: terrain.buildings.filter((b) => b.condition === 'abandoned').length,
    construction: terrain.buildings.filter((b) => b.condition === 'construction').length,
    plantCount: terrain.power.sites.filter((s) => s.kind === 'plant').length,
    substationCount: terrain.power.sites.filter((s) => s.kind === 'substation').length,
    pylonCount: terrain.power.lines.reduce((n, l) => n + l.pylons.length, 0),
    poleCount: terrain.power.poles.length,
    landPercent: Math.round(terrain.landRatio * 100),
    genMs: Math.round(genMs),
    loadMs: Math.round(loadMs),
  };
}

function closestBases({ bases }: Terrain): number {
  let d = Infinity;
  for (let a = 0; a < bases.length; a++)
    for (let b = a + 1; b < bases.length; b++) d = Math.min(d, Math.hypot(bases[a].x - bases[b].x, bases[a].z - bases[b].z));
  return Number.isFinite(d) ? Math.round(d) : 0;
}

function dirtPercent({ heights, dirt, waterLevel, size, play }: Terrain): number {
  let land = 0, sum = 0;
  for (let j = play.j0; j <= play.j1; j++)
    for (let i = play.i0; i <= play.i1; i++) {
      const k = j * size + i;
      if (heights[k] <= waterLevel) continue;
      land++;
      sum += dirt[k];
    }
  return land ? Math.round((sum / land) * 100) : 0;
}

/** Anisotropy ceiling per texture (see `applyQuality`); names not listed use the preset's value. */
const ANISO_CAP: Record<string, number> = { waterNormal: 2, rock: 4, snow: 4, sand: 4, dirt: 4 };

async function loadTextures(): Promise<TerrainTextures> {
  const loader = new THREE.TextureLoader();
  const load = async (name: string, srgb: boolean) => {
    const tex = await loader.loadAsync(`${TEXTURE_BASE}${name}.png`);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    // Full mip chain (generated on upload): distant ground samples a smaller, pre-filtered level instead of the
    // full-resolution texture (no shimmer, less texture bandwidth). Trilinear between levels.
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8; // replaced by the quality preset (see applyQuality)
    return tex;
  };
  const loadNoise = async () => {
    // Lookup table, not an image: exact texels, tiled, no filtering.
    const tex = await load('shadow_noise', false);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = 1;
    return tex;
  };
  const [grass, sand, rock, snow, dirt, asphalt, waterNormal, shadowNoise] = await Promise.all([
    load('grass', true),
    load('sand', true),
    load('rock', true),
    load('snow', true),
    load('dirt', true),
    load('asphalt', true),
    load('water_normal', false),
    loadNoise(),
  ]);
  return { grass, sand, rock, snow, dirt, asphalt, waterNormal, shadowNoise };
}
