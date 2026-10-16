import * as THREE from 'three';
import type { Terrain } from '../terrain/generate.ts';
import { sampleGrid, type GenEvent } from '../terrain/generate.ts';
import { RockLayer } from './rocks.ts';
import { RoadLayer } from './roads.ts';
import { TreeLayer } from './trees.ts';
import { BaseLayer } from './bases.ts';
import { StreetLightLayer } from './streetlights.ts';
import { LandmarkLayer } from './landmarks.ts';
import { PowerLayer } from './power.ts';
import { ParticleSystem } from './particles/system.ts';
import { lodTint, setLodDebug } from './lodDebug.ts';
import { TownLod } from './townLod.ts';
import { CityLodLayer } from './cityLod.ts';
import { GroundLayer } from './ground.ts';
import { BuildingLayer } from './buildings/layer.ts';
import { UrbanLayer } from './urban.ts';
import type { BuildingState } from '../terrain/generate.ts';
import { LightField } from './lights.ts';
import { RenderPipeline } from './pipeline/index.ts';
import type { QualitySettings } from './quality.ts';
import { Culler, type CullStats } from './culling.ts';
import type { FogUniforms } from './atmosphere.ts';
import { SPRITE_PITCH_COUNT, type SpriteShadeUniforms } from './billboard.ts';
import { profiler } from '../core/profiler.ts';

export interface TerrainTextures {
  grass: THREE.Texture;
  sand: THREE.Texture;
  rock: THREE.Texture;
  snow: THREE.Texture;
  dirt: THREE.Texture;
  asphalt: THREE.Texture;
  waterNormal: THREE.Texture;
  /** 64x64 blue-noise rotation map used by the soft-shadow filter (see Lighting). */
  shadowNoise: THREE.Texture;
}

export interface Environment {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyAmbient: THREE.Color;
  groundAmbient: THREE.Color;
  /** Unit vector towards the moon (below the horizon half the time). */
  moonDir: THREE.Vector3;
  /** 0-1: lit share of the moon's disc (phase). */
  moonLit: { value: number };
  /** World direction -> sky (celestial) frame: turns the stars with the time of day. */
  starRotation: THREE.Matrix3;
  /** Aerial perspective / sky LUT uniforms of the fog chunk (Atmosphere.fog), spread into every map material. */
  fog: FogUniforms;
  /** Sun shadow lookup + occlusion strength for far-LOD sprites (filled by Lighting each frame). */
  spriteShade: SpriteShadeUniforms;
  /** 0 (night) - 1 (day): overall sky brightness, for shaders without their own ambient term. */
  daylight: { value: number };
  /** Hour of the day, 0-24 (window light schedules). */
  hour: { value: number };
}

/**
 * Owns the Three.js meshes of the current map (one persistent layer per kind of content) and the render
 * pipeline that builds them from the generator's event stream, a few jobs per frame.
 */
export class World {
  readonly group = new THREE.Group();
  private ground: GroundLayer;
  private rocks: RockLayer;
  private roads: RoadLayer;
  private trees: TreeLayer;
  private bases: BaseLayer;
  private streetLights: StreetLightLayer;
  private landmarks: LandmarkLayer;
  private power: PowerLayer;
  private particles: ParticleSystem;
  /** Third level of detail of towns: the shared switch distance and one merged model per town (skill `render-content-layers`). */
  private townLod: TownLod;
  private cityModels: CityLodLayer;
  private buildings: BuildingLayer;
  private urban: UrbanLayer;
  private env: Environment;
  /** Deferred local lights (street lights...), drawn by Lighting into the light buffer. */
  readonly lights: LightField;
  private fogOrigin = { value: new THREE.Vector3() };
  private pipeline: RenderPipeline;
  private culler = new Culler();
  /** Objects excluded from the shadow-map pass (sprites, water, flat decals). */
  private noShadow: THREE.Object3D[] = [];

  constructor(textures: TerrainTextures, env: Environment, renderer: THREE.WebGLRenderer) {
    this.townLod = new TownLod();
    this.ground = new GroundLayer(textures, env);
    this.rocks = new RockLayer(textures, env, renderer);
    this.roads = new RoadLayer(textures, env, this.townLod);
    this.trees = new TreeLayer(env, renderer, textures.shadowNoise);
    this.bases = new BaseLayer(env);
    this.env = env;
    this.lights = new LightField();
    this.lights.townLod = this.townLod;
    this.lights.uniforms.tNoise.value = textures.shadowNoise; // the blue noise of the lights' town cross-fade (townkeep.glsl); Lighting sets the same one
    this.lights.uniforms.townInfo.value = this.townLod.info; // the light shaders cross-fade a town's detailed lights with its city model's
    this.streetLights = new StreetLightLayer(env, this.lights);
    this.cityModels = new CityLodLayer(env, this.lights, this.townLod, textures.shadowNoise);
    this.buildings = new BuildingLayer(env, this.lights, this.townLod, this.cityModels);
    this.urban = new UrbanLayer(textures, env, this.lights, this.townLod);
    this.landmarks = new LandmarkLayer(env, this.lights);
    this.power = new PowerLayer(env, this.lights);
    this.particles = new ParticleSystem(env);
    this.group.add(
      this.ground.group, this.rocks.group, this.roads.group, this.trees.group, this.bases.group, this.streetLights.group,
      this.buildings.group, this.urban.group, this.landmarks.group, this.power.group, this.particles.group, this.cityModels.group,
    );
    const { ground, rocks, roads, trees, bases, streetLights, buildings, urban, landmarks, power, particles, cityModels, townLod } = this;
    this.pipeline = new RenderPipeline({ ground, rocks, roads, trees, bases, streetLights, buildings, urban, landmarks, power, particles, cityModels, townLod, lights: this.lights });
  }

  /**
   * The content layers as separately drawable groups (name, group), in a draw order that suits an incremental draw (ground
   * first). Used by the profiler's detail mode to time the scene and the shadow pass layer by layer; toggling `visible`
   * on these groups hides a whole layer without touching its meshes' own (culling) visibility.
   */
  layerGroups(): { name: string; object: THREE.Object3D }[] {
    return [
      { name: 'terrain + water', object: this.ground.group },
      { name: 'roads + rails', object: this.roads.group },
      { name: 'bases', object: this.bases.group },
      { name: 'rocks', object: this.rocks.group },
      { name: 'trees', object: this.trees.group },
      { name: 'buildings', object: this.buildings.group },
      { name: 'urban (decals, cars, signals)', object: this.urban.group },
      { name: 'street lights', object: this.streetLights.group },
      { name: 'landmarks', object: this.landmarks.group },
      { name: 'power (plants, pylons, poles)', object: this.power.group },
      { name: 'particles (smoke, steam)', object: this.particles.group },
      { name: 'city models (far towns)', object: this.cityModels.group },
    ];
  }

  /** The finished map (heights, roads graph, rocks...), or null while one is still being built. */
  get terrain(): Terrain | null {
    return this.pipeline.terrain;
  }

  /**
   * Destroyed bits of the current map's buildings (null until they arrive). Changes show at once (body -> rubble);
   * `setBuildingState` follows another state object instead, e.g. one synced from a server.
   */
  get buildingState(): BuildingState | null {
    return this.buildings.state;
  }

  setBuildingState(state: BuildingState): void {
    this.buildings.setState(state);
  }

  /** Build jobs still queued for the current map. */
  get pending(): number {
    return this.pipeline.pending;
  }

  /** Hands one generator event to the render pipeline (`meta` starts a new map). */
  push(event: GenEvent): void {
    this.pipeline.push(event);
  }

  /** Resolves once the current map is fully built. */
  whenBuilt(): Promise<void> {
    return this.pipeline.whenBuilt();
  }

  /** Builds a complete map at once (no streaming). */
  build(terrain: Terrain): void {
    this.pipeline.load(terrain);
    this.pipeline.update(Infinity, new THREE.Vector3());
    this.syncScene();
  }

  /** Runs build jobs for about `budgetMs`, nearest `focus` first. Call once per frame before rendering. */
  step(budgetMs: number, focus: THREE.Vector3): void {
    if (this.pipeline.update(budgetMs, focus)) {
      this.syncScene();
      // The height texture may have been replaced by a new map.
      const heights = this.ground.heightTexture;
      const map = this.pipeline.map;
      if (heights && map) this.lights.setGround(heights, map.worldSize, map.size);
    }
    if (profiler.isRecording) profiler.count('build', 'queued jobs', this.pipeline.pending);
  }

  private sceneEpoch = 0;

  /** Changes whenever what casts shadows changed (meshes built / rewritten, buildings destroyed or repaired): a cached shadow map is then stale. */
  get shadowEpoch(): number {
    return this.sceneEpoch + this.buildings.changes;
  }

  /** Registers added / removed / rewritten meshes with the culler and the shadow-pass exclusions. */
  private syncScene(): void {
    this.sceneEpoch++;
    // Every chunk mesh of every layer gets a frustum test per frame.
    const t = profiler.begin('build', 'scene sync (culler registration)');
    this.ground.flushSupers();
    this.culler.sync(this.group, 1); // margin: tree sway, ribbon lift
    for (const g of [this.roads.group, this.bases.group]) g.traverse((o) => (o.userData.noShadow = true));
    if (this.lodDebug) setLodDebug(this.group, true); // meshes built while the LOD levels view is on
    this.noShadow = [];
    this.group.traverse((o) => {
      if (o.userData.noShadow) this.noShadow.push(o);
    });
    profiler.end(t);
  }

  private lodDebug = false;

  /** The "LOD levels" debug view: every mesh tinted by its level of detail (lodDebug.ts). */
  setLodDebug(on: boolean): void {
    this.lodDebug = on;
    setLodDebug(this.group, on);
  }

  /** Applies a quality preset: view distances of billboards, terrain detail and lights. */
  setQuality(q: QualitySettings): void {
    this.trees.setLodDistance(q.spriteDistance, q.propDistance);
    this.rocks.setLodDistance(q.spriteDistance, q.propDistance);
    this.ground.setLodScale(q.terrainLodScale);
    this.lights.setDeferred(q.deferredLights && q.post);
    this.lights.setShafts(q.lightShafts && q.post);
    this.lights.setReflections(q.lightReflections && q.post);
    this.lights.setBokeh(q.bokeh);
    this.streetLights.setLodDistance(q.lightDistance * 0.5);
    this.buildings.setLodDistance(q.buildingDistance);
    this.urban.setLodDistance(q.lightDistance * 0.5);
    this.townLod.setDistance(q.cityDistance, [this.group, this.lights.scene, this.lights.fakeGroup]);
    this.lights.setDeferredDistance(q.lightDistance * 0.5); // deferred lights for the close ones, the overlay pools beyond
    this.urban.setTownDistance(q.cityDistance);
    this.cityModels.setRanges(q.lightDistance * 0.5, q.buildingDistance);
    this.particles.setDensity(q.particleDensity);
  }

  /** Far-LOD sprites flag their pixels for the lighting pass only when that pass runs (see billboard.frag.glsl). */
  setSpriteMark(on: boolean): void {
    for (const m of [...this.rocks.billboardMaterials, this.trees.billboardMaterial]) m.uniforms.markSprite.value = on ? 1 : 0;
    this.particles.setCoverageMark(on);
  }

  /** Re-bakes the far-LOD sprites after the lighting changed (they carry baked shading). */
  refreshSprites(): void {
    // `update` bakes one pitch column per frame (a full re-bake in one frame is a ~20 ms spike). A change during a sweep
    // doesn't restart it (dragging the time slider would keep re-baking the first columns only): another sweep follows.
    if (this.spriteColumn < SPRITE_PITCH_COUNT) this.spriteRebakeQueued = true;
    else this.spriteColumn = 0;
  }

  /** Next pitch column of the sprite atlases to re-bake; SPRITE_PITCH_COUNT = nothing pending. */
  private spriteColumn = SPRITE_PITCH_COUNT;
  /** The light changed again during the current sweep. */
  private spriteRebakeQueued = false;

  /** Hides chunk meshes outside the camera frustum. Call once per frame before rendering. */
  cull(camera: THREE.Camera, lodCamera: THREE.Object3D = camera): CullStats {
    return profiler.scope('cull', 'main view (frustum + LOD)', () => {
      // Undo a preceding shadow pass for what the Culler doesn't manage (groups, uncullable meshes); it re-shows the rest itself.
      for (const o of this.noShadow) if (!(o instanceof THREE.Mesh) || o.userData.noCull) o.visible = true;
      return this.culler.update(camera, lodCamera);
    });
  }

  /**
   * Visibility for a shadow-map pass seen from `lightCamera`: its own frustum (casters off screen still cast), the main
   * `camera`'s detail levels (each object casts with the mesh the view draws; far trees / rocks with their low-poly
   * shadow proxies instead of the sprites). Call `cull` afterwards.
   */
  cullShadow(lightCamera: THREE.Camera, camera: THREE.Camera): void {
    profiler.scope('cull', 'shadow casters (sun frustum + main LOD)', () => {
      this.culler.update(lightCamera, camera, true);
      for (const o of this.noShadow) o.visible = false;
    });
  }

  /**
   * `game`: the game camera (the one culling / LOD follow). Fog and halo distances are measured from its position, and
   * billboards face it (a frozen debug camera keeps all of that put while another camera looks around).
   */
  update(time: number, game: THREE.Camera): void {
    if (this.spriteColumn < SPRITE_PITCH_COUNT) {
      const col = this.spriteColumn++;
      profiler.scope('time of day', 'sprite re-bake (one column)', () => {
        this.trees.rebakeColumn(col);
        this.rocks.rebakeColumn(col);
      });
      if (this.spriteColumn === SPRITE_PITCH_COUNT && this.spriteRebakeQueued) {
        this.spriteRebakeQueued = false;
        this.spriteColumn = 0;
      }
    }
    game.updateMatrixWorld();
    this.fogOrigin.value.setFromMatrixPosition(game.matrixWorld);
    const { gameRight, gameUp } = this.lights.uniforms;
    (gameRight.value as THREE.Vector3).setFromMatrixColumn(game.matrixWorld, 0);
    (gameUp.value as THREE.Vector3).setFromMatrixColumn(game.matrixWorld, 1);
    const { terrainMat, waterMat, skirtMat } = this.ground;
    waterMat.uniforms.time.value = time;
    const day = this.env.daylight.value;
    profiler.scope('update', 'trees', () => this.trees.update(time));
    profiler.scope('update', 'street lights', () => this.streetLights.update(day));
    profiler.scope('update', 'buildings', () => this.buildings.update(day));
    profiler.scope('update', 'urban (signals, car parks)', () => this.urban.update(time, day));
    profiler.scope('update', 'landmarks', () => this.landmarks.update(day));
    profiler.scope('update', 'power', () => this.power.update(day));
    this.particles.update(time);
    this.cityModels.update(day);
    this.lights.setTime(time);
    // Edge haze over the outer three quarters of the grid margin beyond the play area (fogdist.glsl).
    const map = this.pipeline.map;
    const play = map ? map.playSize / 2 : 1e9;
    const grid = map ? map.worldSize / 2 : 2e9;
    const near = play + (grid - play) * 0.25;
    const far = grid - 2;
    for (const m of [...this.extraFogMaterials, terrainMat, waterMat, skirtMat, this.rocks.material, ...this.rocks.billboardMaterials, ...this.roads.materials, this.trees.material, this.trees.billboardMaterial, ...this.bases.materials, this.streetLights.material, ...this.buildings.materials, ...this.urban.materials, this.landmarks.material, this.power.material, ...this.particles.materials, ...this.cityModels.materials]) {
      m.uniforms.lodTint = lodTint; // LOD levels debug view (lodDebug.ts)
      m.uniforms.fogNear.value = near;
      m.uniforms.fogFar.value = far;
      m.uniforms.fogOrigin = this.fogOrigin; // shared objects; the first frame precedes the first draw
      m.uniforms.gameRight = this.lights.uniforms.gameRight;
      m.uniforms.gameUp = this.lights.uniforms.gameUp;
    }
    this.lights.setFog(near, far, this.fogOrigin.value);
  }

  /** Materials of content drawn outside the map layers (game entities): they get the same per-frame fog / haze uniforms. */
  private extraFogMaterials: THREE.ShaderMaterial[] = [];

  addFogMaterial(m: THREE.ShaderMaterial): void {
    if (!this.extraFogMaterials.includes(m)) this.extraFogMaterials.push(m);
  }

  removeFogMaterial(m: THREE.ShaderMaterial): void {
    this.extraFogMaterials = this.extraFogMaterials.filter((x) => x !== m);
  }

  /** Terrain height at world (x, z), clamped to the grid bounds; follows the map while it streams in. */
  heightAt(x: number, z: number): number {
    const t = this.pipeline.map;
    if (!t) return 0;
    const half = t.worldSize / 2;
    return sampleGrid(t.heights, t.size, (x + half) / t.cell, (z + half) / t.cell);
  }
}
