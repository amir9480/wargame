---
name: terrain-bases-cities
description: Details of player bases, cities (street grids), buildings (types, specs, conditions, cranes, car parks, pads) and town streets (intersections, signals, sidewalks, junction plates). Load before changing bases.ts, cities.ts, buildings.ts, buildings/*, urban.ts or anything that depends on where towns / buildings stand.
---

# Player bases (`modules/bases.ts`)
- Always 4 slots (`PLAYER_SLOTS`), clockwise from north-west; player colours (`render/bases.ts` `PLAYER_COLORS`, shared with game units / structures / HUD): blue (slot 0, the human), red, gold, purple.
- Square build area, preferably 80×80 m (half = 20 cells); falls back to 72/64/56 m when land is tight. Rule sets (`RULES`) relax slope/buildable share before size; layout score = min(spacing, `TARGET_GAP`=0.4·N) + 4·half.
- Hard exclusions inside a base: water, river (±1 cell), mountain > 3 m.
- Fast search via summed-area tables; spread via farthest-point selection (40 random starts).
- Area levelled to its mean keeping 25% relief, blended over 8 cells. `Base { slot, x, y, z, size, i0, j0, i1, j1 }` (cell box inclusive).
- Typical spacing ≥150 m between closest bases on 90% of maps, median ~196 m (3-sea-side maps can be ~90 m).

# Cities (`modules/cities.ts`)
- Radius × `linearScale` (scale.ts; towns grow with the map, counts do not). Count roll 0/1/2 (30/45/25%). Site = best score of distance to the nearest base (contested) − 0.35 · distance to the play area centre (+ noise), over dry gentle land (SAT); never water, river ±3, mountain > 1.5, base square + 10. Radius 30–44 cells, retried at ×0.8 / ×0.65; 2nd city keeps clear of the 1st.
- Shape = noise-ragged disc of usable cells connected to the centre (`cityMask` = id+1). Levelled to its mean keeping 30% relief. `City { id, x, y, z, radius (m), angle, block }`.
- Street grid: two families of parallel lines `block` (20–26 cells) apart at a random angle, clipped to the shape, nodes at crossings and ends; largest connected piece; < 4 streets ⇒ no city.
- Roads: streets are laid first as straight asphalt edges between `junction` nodes (after the base nodes, ids 0..3); each city is routed (asphalt) to its two nearest bases. Rail keeps out of city discs. **No city ⇒ no extra rng draws.**

# Buildings (`terrain/buildings/`, `modules/buildings.ts`)
- `buildingSpec(seed, type)` (`buildings/spec.ts`): pure, own `mulberry32(seed)`. Footprint (`width` local X = road, `depth` local Z = front), `height`, `floors`, `litShare`, colours, `parts` (`block` with window grid / doors, `gable`, `hip`, `shed`, `saw`, `slab`, `cylinder`; `detail` parts near-LOD only) and `lights` (gas canopy). Types: villa, apartment (3–6 floors), office (6–12, podium), market (awnings, lit sign), gas (canopy, pumps, kiosk), warehouse (or factory), farmhouse, barn (+ silo).
- `Building { id, seed, type, x, y, z, yaw, width, depth, height, floors, condition, city, crane }`: local +Z (front) points along (sin yaw, cos yaw), facing its road. `condition` = `intact | abandoned | construction` (~7% town / ~18% rural left behind; half of those, by `hash32(seed, 0xc0b5)`, are unfinished construction sites).
- **Cranes** (`buildings/crane.ts` `planCranes`): 30% of construction sites get a `Crane` (mast, jib, counter-jib, heading) that clears the ground by 13 m, other buildings by 3 m, other beams; else null.
- Placement: (1) one gas station on a road leaving each city; (2) every non-rail edge, both sides: town lots (offices/flats core → villas/warehouses rim) or rural lots where settlement noise is high (hamlets) plus rare lone farms. Footprints never cover road mask (tested 1 m beyond walls, setbacks ≥ 3.2 m), water, river ±2, mountains, base squares + 4; exact rectangle overlap test.
- Town car parks (`Terrain.parking`): 20% instead of a lot, 75% right after a market / office; 6–12 bays per row, entrance gap; cars cosmetic (`lot.seed`).
- Pads: footprint + 1 m yard levelled to its mean, blended over 4 m; never road-levelled / base / water cells. Footprints + per-type clearing (`CLEARING`) go into `ctx.clear`, plus the whole city mask; cover wears footprint + yard (`builtMask`).
- `BuildingState` (`buildings/state.ts`): runtime destroyed bits (`Uint32Array`), `isDestroyed/setDestroyed/reset`, `onChange`, `version`, `toBytes/fromBytes`. Not part of `Terrain`; the render layer creates one per map (`engine.buildingState`).

# Town streets (`terrain/urban.ts`, pure, no rng stream)
- `townAt(cities, x, z)`: within `TOWN_REACH` (1.25) × City.radius. `planIntersections(t)`: town nodes with ≥ 3 road edges (no rail); each approach gets `crosswalk`, signal `group` and a traffic light `pole`. Signals at every 4-way and half of the 3-way junctions. `signalAt(time, group, offset)` = green 9 s / yellow 2.5 s / red (cycle 23 s), same formula as `trafficlight.frag.glsl`; render clock = `World.update` time.
- Sidewalks are **not geometry**: town asphalt ribbons are drawn wider (`CURB_GAP` 0.2 + `SIDEWALK_WIDTH` 3 m) and the road shader paints curb + paving on them (`aWalk`).
- Town nodes get a **junction plate** (`buildPlate` in roads.ts): polygon reaching each arm's crosswalk with block corners between arms; dead ends get a round turning circle.
- Street lights (`terrain/streetlights.ts` `planStreetLights`, pure, no RNG): town every 9 m alternating sides on the sidewalk; elsewhere asphalt 18 m, dirt 30 m; skip bridges, nodes, banks, other roads/trees/rocks/**utility poles**. Car-park lamps `planParkingLights`.
