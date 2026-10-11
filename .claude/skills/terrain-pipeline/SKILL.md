---
name: terrain-pipeline
description: How the procedural terrain generator is built - pipeline stages and their order, the shared GenContext, events, the Terrain fields, per-module random streams, landmarks, and the checklist for adding a new generated content type (generator stage + render layer). Load before touching anything in src/terrain/ or adding generated content.
---

# Terrain generation pipeline (`src/terrain/pipeline/`)

`generate.ts` → `generateTerrain(seed, mountains, options)` drains `runPipeline`. Generation is pure TS (no Three.js) so it runs in Node, workers or a server.

- `pipeline/run.ts` `runPipeline(seed, mountains, opts)`: a JS generator running the stages of `pipeline/stages.ts` in order over one shared `GenContext` (`pipeline/types.ts`), yielding `GenEvent`s (`stage`, `meta`, `heights` rows, `rivers`, `bases`, `cities`, `roads`, `buildings`, `landmarks`, `power`, `cover` rows, `rocks` / `trees` bands, `done` with the full `Terrain`). All plain data so it can be posted from a worker. `GEN_STAGES` (types.ts) lists the stage names for the progress label.
- Chunked stages work in 32-row bands (`GEN_BAND`): relief (centre bands first; per-cell pure), cover, rocks, trees. Rocks/trees bands run top to bottom so the rng stream is consumed exactly as in a single pass. **Output must stay bit-identical** to `generateTerrain`.
- Browser: `terrain/worker.ts` runs the pipeline in a Web Worker; `terrain/generator.ts` `TerrainGenerator` posts jobs and forwards events (falls back to the main thread, one event per macrotask).
- **Default options differ from the app**: `generateTerrain` defaults to `size 256, cell 2, pad 64`; the app generates `{ size: MAP_SIZE, cell: MAP_CELL }` from `terrain/scale.ts` (`MAP_SCALE = 4` ⇒ 1280 cells, play area ≈ 2558 m). Test with the app's options too (distances in metres matter, cell counts scale).
- **Scaling** (`scale.ts`): `MAP_SCALE` (area vs the 640 reference) sets `MAP_SIZE`. What follows it: mountain summit height (`relief.ts`: peaks × `linearScale`, so a 2x wide map has 2x high mountains with the same slopes; `SNOW_LINE` stays 80 m, so the snow line sits lower on the taller peaks), town size (`linearScale`: city radius in `cities.ts`, plant distance in `power.ts`), the rural road web (`areaScale`: `buildWeb` in `roads/network.ts`, see skill `terrain-roads`) and the countryside's building density (`linearScale` in `buildings.ts`: hamlet / lone-farm chance up, gaps down). What does not: how many cities, rivers, plants, landmarks, bridges. Both scales are never < 1, so maps up to 640 generate bit-identically (check with a hash of heights + power + roads at size 640 after touching a scaled module). Anything that loops over every cell per site (power `findSite`, base `pickSpread`) must stay cheap: at scale 4 generation takes ~20-30 s in Node. The wet mask texture caps at 4096 texels per side (`wetmask.ts`).

## Random streams (`seeds.ts`)

`STAGE = { sea:1, shape:2, detail:3, rivers:4, ranges:5, rocks:6, roads:7, cover:8, trees:9, bases:10, rails:12, cities:13, buildings:14, lighthouses:15, towers:16, power:17 }`; 11 retired, never reuse, **never renumber**. Each module gets `stageRng(seed, STAGE.x)`. Render-side cosmetic randomness is seeded too (`hash32(seed, salt)`). Pure planning code (street lights, poles' look, building specs) uses hashes, not a stream.

## Stages (in order)

| stage | module | what |
|---|---|---|
| layout | `modules/sea.ts`, `ranges.ts` | 0–3 sea sides with ragged coasts (3 sea sides ⇒ seas narrowed ×0.6 so 4 bases fit); land edges get mountain ranges with 80% chance (40–65 m at the play border, ×2.2 to a main ridge ~90–145 m outside it, falling to 10% at the grid edge; shallow saddles: ways out are tunnels) |
| relief | `modules/relief.ts` | base heightmap (smooth, low-frequency, RTS-friendly) + `mountain` field (height added by peaks, real heightmap patches from `mountains/library.ts`); 2 blur passes at the end |
| rivers | `modules/rivers.ts` | 1–4 rivers from the grid's outer land edges to sea (or across), via waypoints on the play border; ends inside a mountain (`mountain` > 5 m) or past the play border on a range side are dropped (a mouth in the sea is kept). A dropped head that came down a mountain becomes `River.stream` (mountain stream: `carveStreams`, `ctx.streamMask`: roads treat it as water, rocks/trees keep off; drawn as water ribbons). Valley width stops growing above 25 m; returns `mask` (river id+1) and centre `paths`; blur softens banks |
| bases | `modules/bases.ts` | 4 player start areas, **levels terrain** (see skill `terrain-bases-cities`) |
| cities | `modules/cities.ts` | 0–2 towns with street grids (see `terrain-bases-cities`) |
| roads | `modules/roads/*` | road network, **cuts/fills terrain** (see skill `terrain-roads`) |
| buildings | `modules/buildings.ts` | buildings along non-rail roads, flat pad each (see `terrain-bases-cities`) |
| landmarks | `modules/landmarks.ts` | 0–4 lighthouses on beaches (needs a sea side), 0–3 telecom towers (radar/radio) high on mountains; small levelled pads, `clearing` for rocks/trees; own streams `lighthouses` / `towers`; render side `render/landmarks.ts` |
| power | `modules/power.ts` | plants, substations, pylon lines, utility poles (see skill `terrain-power`) |
| cover | `modules/cover.ts` | dirt amount per cell (~30% of land), grassier near rivers, worn along roads |
| rocks | `modules/rocks.ts` | boulders mostly at mountain feet; avoid roads + bases; none in snow (top < `SNOW_LINE` − `SNOW_MARGIN` = 24 m) |
| trees | `modules/trees.ts` | one species per map (`pine` / `broadleaf`), forest clumps; avoid mountains, water, roads, rocks, bases |

`ctx.clear` = cells rocks and trees keep off. Roads, stream channels, bases (+3 cells) go in at the roads stage; buildings add footprint + clearing + the whole city mask; landmarks and power add their pads / pylon feet / poles. A module that places things must add them to `ctx.clear`, and a module that levels ground must yield a `heights` event afterwards.

`Terrain` fields: `seed, size, cell, worldSize, play, playSize, waterLevel, heights, seaSides, mountainSides, rivers, bases, cities, roads, buildings, parking, lighthouses, towers, power, rocks, dirt, mountain, trees, landRatio`. Generation ≈ 0.5–1.5 s in Node (worker in the browser; page stays responsive).

## Adding a new generated content type (checklist)

1. `modules/<name>.ts`: pure function, own `STAGE` number (new, appended), reads what earlier stages left in the `GenContext`. Never `Math.random()`.
2. `pipeline/types.ts`: field on `Terrain` and `GenContext`, a `GenEvent` kind, the stage name in `GEN_STAGES` (in order, before `finish`). `pipeline/run.ts`: init in `createContext`, copy in `assemble`. `pipeline/stages.ts`: the stage (yield `heightsEvent` if it levels ground, add to `ctx.clear`, yield its event) and put it in `GENERATOR_STAGES`. Export types from `generate.ts`.
3. Render side (see skill `render-architecture`): handler in `render/pipeline/stages.ts` (store on `ctx.map`, queue a job), an empty value in `RenderPipeline.begin` and a push in `RenderPipeline.load`, a layer class registered in `world.ts` (group, `update`, fog-uniform material list, `layerGroups`), `clear()` in `begin`.
4. Near/far LOD + halo/LightField for lights (core rules 5 and 6 in CLAUDE.md).
5. Info row: `MapInfo` in `engine.ts` (`mapInfo`) + `index.html`.
6. Verify: determinism hash, streamed events == `Terrain`, 100+ seeds of health metrics (skill `testing-workflow`).
7. Update the matching skill file (and CLAUDE.md only if it changes a rule used by every change).
