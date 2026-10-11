---
name: terrain-power
description: The electricity network - power plants, substations, high-voltage pylon lines (incl. import lines from mountain edges), roadside utility poles and landmark feeds (modules/power.ts, render/power.ts). Load before touching power, pylons, poles, plants, substations or anything that must keep clear of them.
---

# Power network

Generator: `src/terrain/modules/power.ts` (stage `power`, after `landmarks`, before `cover`; stream `STAGE.power` = 17). Render: `src/render/power.ts` `PowerLayer`. Data on `Terrain.power: PowerGrid { sites, lines, poles, links }`, event `{ kind: 'power' }`.

## Rules
- **Every city ⇒ ≥ 1 plant** (+ a substation per city on its edge, facing the plant). 2 cities ⇒ 2nd plant 40%. No city ⇒ plant 50%. Verified over 200 seeds: 0 cities without plant.
- **Utility poles exist on every map**, plant or not (no site ⇒ fed from outside the map through road exits, else the bases).
- Sites: `PowerSite { kind plant|substation, x,y,z, yaw (multiple of 90°), width, depth, seed, city, stacks, coolers, feeder }`. Standard pad plant 64×48 m, substation 24×18 m; pads **shrink** (scale 1 → 0.4, `SITE_SCALES`) and slope limits relax (`SLOPE_TIERS`) when land is tight (`siteScale(site)`; models scale with the pad). Search uses summed-area tables over "blocked" cells (taken / river / low / mountain / steep), margin `SITE_MARGIN` 3 cells, ground levelled flat over the pad (blend ring leaves taken cells alone). Plant placed ~110 cells from its city, substation 6–60 cells beyond the town reach (`TOWN_REACH`) near a road.
- **High-voltage lines**: minimum spanning tree over the sites (plant 0 first). `routePylons`: straight line from fence to fence, a pylon about every `PYLON_SPAN` (70 m), each slid along (±30 m) / sideways (±12 m) to ground that is dry, not river, not taken, slope ≤ 0.3. `Pylon { x,y,z,yaw,height }`, arms along local X, the line along local +Z. Constants/helpers shared with the renderer: `PYLON_ARMS`, `PYLON_PEAK`, `INSULATOR`, `pylonAttach(p)` (6 conductors + earth wire), `siteGantry(site)` (where the line ends), `siteToWorld`.
- **Import lines**: where a mountain range closes a grid edge (`mountainSides`) and a plant exists, a line comes from the grid edge on that range to the nearest plant (max 2 sides; `PowerLine.a = -1` = starts at the map edge, no gantry; steeper ground allowed, `MOUNTAIN_PYLON_SLOPE`).
- **Utility poles** (`planPoles`): Dijkstra over the road graph from the source (substation's nearest road point outside the town, or exit/base nodes without sites) marks which edges carry poles: every edge on the shortest path to a lived-in rural building (≤ 900 m) or a base (≤ 1600 m). Poles ~40 m apart, 2.9 m beyond the road edge on a preferred side per edge (other side as fallback), never in town (underground), on bridges, in water/rivers/bases, near buildings (`BUILDING_CLEARANCE`), other roads. `links` wire consecutive poles (≤ 100 m) and junction hubs; site feeders: `PowerSite.feeder` = first pole of the run from the site's fence. Pole-mounted transformers (`transformer`) near served buildings.
- **Landmark feeds**: every lighthouse and telecom/radar tower gets a run of poles to the nearest pole of the network (≤ 800 m); first pole tries several directions/distances round the foot (beaches). `PowerInput.landmarks`.
- Poles/pylons/pads are added to `clearing` (→ `ctx.clear`) so rocks and trees keep off; street lights keep 0.3 m + clearance off poles (`planStreetLights`).

## Render (`render/power.ts`)
- Building shaders (`building.vert/frag`), `MeshData` with extras `aWin`, `aKey`; merged per chunk and category with near/far meshes: sites near < 450 m (far always), pylons near < 350 (far ≤ 2000), poles near < 220 (far ≤ 900). Pylon spans carry orange/white aviation marker balls on the earth wire (`markerBalls`, every 36 m, clear of the pylons; in the normal pylon meshes, not the fading wire ones). Wires = sagging chains of thin boxes (`wire`; far ones thicker) in their own meshes (`drawWire`, `wire.vert/frag.glsl`, `aThick`): opacity = share of a pixel covered, drawn as a screen-space dither (no blending) and fully gone beyond 1800 m, so distant wires fade instead of aliasing; pole slot choice flips per pole so wires don't cross (`poleAttach`).
- Plant: turbine hall, boiler house, 1–2 banded stacks, 0–2 hyperbolic cooling towers (or an air-cooled bank), tanks, switchyard + gantry; **stack and cooling-tower tops carry black caps** (open tops showed the ground through). Substation: transformers, gantry, control hut, fence.
- Lights through the `LightField`: yard floodlights (`siteLamps`, on at night, with halos) and blinking red beacons on the stacks (animated group). `update(daylight)` drives levels.
- Info row in the panel (`engine.ts` `mapInfo`: plant/substation/pylon/pole counts).

## Verification ideas
Per seed: cities > 0 ⇒ plants ≥ 1; no pole in town, in water or inside a building; no site over a road/building; max link ≤ 100 m; landmarks within a pole feed; deterministic; streamed `power` event equals `Terrain.power`. Run with the app's options (`{ size: 640, cell: 2 }`).
