---
name: particles
description: The GPU-instanced particle system (render/particles/*, shaders/particle.*) - effects registry, emitters, LOD/density/culling, blending rules, and which map objects smoke (plants, factories, chimneys). Load before adding an effect or emitter, changing smoke/steam, or touching particle shaders.
---

# Particles (`src/render/particles/`)

Smoke, steam and any future puff effect (fire, dust, exhaust). **GPU-simulated**: a particle is a pure function of the render clock and its slot, computed in `shaders/particle.vert.glsl`. The CPU writes two instance attributes once (`build`) and per frame only sets `time`. No per-particle CPU state, so cost = instances drawn.

## Files
- `effects.ts`: `ParticleEffect` (count, life, rise, spread, wind drift, sizes, opacity, colours, LOD distances), the `EFFECTS` registry (`stackSmoke`, `steam`, `factorySmoke`, `chimney`) and `ParticleEmitter { effect, x, y, z, seed, scale?, intensity? }` (world coordinates of the emitter mouth).
- `system.ts`: `ParticleSystem` (a World layer: `group`, `materials`, `build(emitters, grid)`, `update(time)`, `clear()`, `setDensity`, `setWind(angle, speed)`, `setIntensity(id, 0..1)` where id = index in the `build` list).
- `sources.ts`: `collectEmitters(terrain)` decides what emits (pure, seeded by owners' own seeds via `hash32`, **no generator rng stream**). Imports `render/power.ts` (glsl), so it cannot run in plain Node.
- `shaders/particle.vert/frag.glsl`.

## Who smokes
- Power plants: every stack (`plantStacks`) → `stackSmoke`; every hyperbolic cooling tower (`plantCoolers`, exported from `render/power.ts`, same positions as the model) → `steam`. Scale follows the shrunk plant (`siteScale`).
- Factory halls (warehouse spec with a cylinder part `h ≥ 12`, 85% running), ~35% of villas/farmhouses (narrow tall detail slab = chimney) → `factorySmoke` / `chimney`. Only `condition === 'intact'` buildings smoke.
- Destroyed buildings do not smoke yet (idea: `BuildingState.onChange` → `setIntensity` / a burning effect).

## How it works / rules
- **Binning + LOD**: emitters are binned per effect and 64 m chunk into one `InstancedBufferGeometry` mesh per level. Near level = `count` small puffs (`lodMax = nearDistance`), far level = `farCount` bigger puffs (`farSize`, `lodMin = nearDistance`, `lodMax = farDistance`). The shader cross-fades them (`lodNear ± lodBand`) and fades the far level out from 80% of `farDistance`; mesh `lodBlend = band + 64` keeps the Culler's chunk test wider than the shader's per-emitter one. Fine puff pattern (billowy noise) only inside `surfaceDetail` (160–260 m); beyond, a plain soft disc.
- **Culling bounds**: the mesh's geometry is a unit quad, so meshes carry `userData.cullBox` (emitters ± reach, up to rise height); `Culler.item` uses it. Any GPU-displaced mesh needs the same.
- **Quality**: `QualitySettings.particleDensity` (0.4 / 0.7 / 1 / 1) → `setDensity`: slots above the share are collapsed in the vertex shader.
- **Blending**: colour blends normally. Alpha channel: with the post pass the target alpha becomes `1 - coverage` (`blendDstAlpha OneMinusSrcAlpha`, via `setCoverageMark`, called from `World.setSpriteMark`), and `post.frag.glsl` fades shadows / AO / contact shadows / local lights with it (`fx`) because particles write no depth and the post effects would otherwise be computed for the ground behind and painted over the smoke; far sprites keep alpha 0 = untouched. Without the post pass alpha stays 1. `depthWrite: false`, depth-tested, `renderOrder 10`. Not sorted (soft puffs hide it).
- **No shadows**: meshes have `userData.noShadow`. Smoke emits no light (so no `LightField` entry); if a future effect glows (fire), register `LightDef`s via a `LightGroup` and a halo (CLAUDE.md rule 6).
- Shading: sphere-like normal from the quad uv, sun + sky ambient from the billboard-space sun / up vectors (`vSun`, `vUp`), fog via `applyFog`.
- Wind: one global vector set per map in `RenderPipeline.begin` from `hash32(seed, 0x91d / 0x91e)`, with a slow gust. Plume bends by `windDrift`.
- Per-map pipeline: queued in `done` (`RANK.lights`, key `particles`), cleared in `RenderPipeline.begin`.

## Adding an effect
1. Entry in `EFFECTS` (+ `EffectId`): tune `count`, `life`, `rise`, sizes, colours, `nearDistance`/`farDistance` (far limit ≈ how far the thing should be readable; it is cheap: `farCount` instances per emitter).
2. Emit it from `sources.ts` (or call `ParticleSystem.build` with your own list). Use a stable `seed` from the owner's seed.
3. Materials are created per effect on first use and appear in `ParticleSystem.materials` (World adds them to the per-frame fog uniform loop).
4. Check: shows near and far, fades out at `farDistance`, is absent in the shadow pass, no alpha artefacts on `low` quality (no post pass: destination alpha preserved) and no shadows painted over the plume with the post pass.

## Ideas
Soft intersection with geometry (needs a depth copy), sorting plumes back to front, stopping smoke of destroyed/abandoned factories at runtime, a burning-ruin effect, vehicle dust.
