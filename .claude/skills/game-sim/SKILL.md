---
name: game-sim
description: The RTS gameplay layer - authoritative tick sim (src/game), commands/events/snapshots, economy + power + production, combat, AI opponents, GameSession, client replica, GameController/HUD (src/ui), placeholder GameLayer rendering and Jolt. Load before changing anything in src/game, src/ui/gameController.ts, src/ui/hud.*, src/render/game or index.html's #hud.
---

# Architecture (plan: `~/.claude/plans/i-m-trying-to-make-starry-piglet.md`)

```
GameController (src/ui) ── send(Command) ─▶ GameSession ─ LoopbackChannel ─▶ Simulation (authoritative, 20 Hz)
      ▲  HUD polls hudState()                  │  AIPlayer x3 call think(sim) before each tick
      └─ GameLayer reads ClientState ◀── events + transforms (binary codecs) ──┘
```
- `src/game/**` is pure TS (no Three), runs in Node (`pnpm sim-check`). The sim currently runs on the **main thread** through
  `LoopbackChannel`; moving it to a Worker/WebSocket means implementing the same send/deliver pair (planned P0 leftover).
- **The renderer/HUD only read `ClientState` (the replica)**, built from `GameEvent`s + `TransformBatch`es (+ `restore(snapshot)`).
  Never import `Simulation` into render/UI code (except `GameSession`, the host).
- Ids in `defs/*.ts` and in `messages.ts` (`commands.define`/`events.define` numbers) are part of saves/wire: **never renumber**.

# Sim (`sim/simulation.ts`)
- `step()` order: commands → power recompute (if dirty) → construction → production → income (every 10 ticks) → combat → movement →
  credit events → transforms (every `SNAPSHOT_EVERY` ticks) → `stateHash` event (every `HASH_EVERY`) → checkpoint.
- Entity store (`store/entities.ts`): SoA typed arrays, id = (gen<<16)|index. Replicated fields are hashed (`hash()`); sim-only: `tx,tz,cool,engaged,dirty`.
  **If a sim change alters a replicated field outside spawn/progress/hp events, set `dirty[i] = 1`** (transforms) or emit an event, else the replica desyncs (sim-check catches it).
- **Synced 0..1 value** (structures under construction): `pBase` (u16) at `pTick` advancing at `pRate`/s; `progressAt(i, tick)`.
  Events `structureProgress` re-baseline on rate change (power factor change). Production uses the same idea (`productionProgress`, `ProductionState`).
  Complete = `pBase === 65535 && pRate === 0` (`isComplete`).
- Economy: credits spent at placement/queue (sell/cancel refunds), depots/CC give income, power factor = produced/consumed (min 0.25) scales build/production rate.
  Placement rules are in `sim/placement.ts` (`checkPlacement`), shared by sim validation, AI and the HUD ghost (`GameSession.checkPlacement`).
- `World` (placement.ts) = `heightAt` + `buildable(x,z,r)`; `TerrainWorld` in `session.ts` implements it from `Terrain` (slope, water, mountain, map buildings).
- Combat: nearest enemy via a hashed grid, hitscan, 0.5 s reload; MG turrets need completion. A moving armed unit with an enemy in range
  (`engaged`) stands still and fires (route + order kept), then `moveSystem` resumes it (every move is effectively attack-move).
  The killer's owner gets a bounty (`BOUNTY_UNIT` 40 % / `BOUNTY_STRUCTURE` 25 % of cost, `creditsChanged`); selling pays no bounty.
- `separationSystem` (after movement, reuses the combat grid): units are pushed out of each other (radius x `UNIT_SCALE`) and out of structure footprints; pushes into
  terrain-blocked cells are skipped. Bridges: `nav/decks.ts` `BridgeDecks` rasterises driveable bridge spans; `TerrainWorld.heightAt` = deck on a bridge, `groundAt` = bare terrain
  (placement uses ground). The render layer gets units' height from `session.world.heightAt` so they ride the deck.
- Units are drawn at `UNIT_SCALE` (units.ts, 0.6) of their life-size models; rings, bars and picking use it too (sim radii/ranges unchanged).
  Player with no structures left is defeated (all its entities removed, `playerDefeated`).
- Snapshots (`store/snapshot.ts`, `SNAPSHOT_VERSION`): header + JSON extras (credits, power, production...) + free list + arrays. AI state (`AIState`) is **not** saved yet.
- Randomness: `simRng(seed, SIM_STREAM.x, tick, salt)`; render-side jitter uses `hash32`. No `Math.random()` in sim.

# Navigation (`nav/navgrid.ts`)
- `NavGrid(terrain)`: 4 m cells; per mover class (`foot | wheeled | tracked`) a cost grid (0 blocked; open 10, rough 14, light forest for foot 22, road 4).
  Blocked: water, slope over the class limit, outside the play area, map buildings (inflated), rocks, trees (vehicles any, foot dense stands), player structure footprints
  (dynamic: `addFootprint` / `removeFootprint`, bumps `epoch`). Vehicle classes are inflated one cell (roads exempt). Roads (not rail) override everything but the play limit (bridges!).
- `findPath(mover, sx, sz, gx, gz)`: weighted A* (heuristic 7, 8-connected, no corner cutting, 220k-expansion budget, reused typed buffers) + line-of-sight string pulling.
  Returns flat waypoints or null. `los`, `nearestFree`, `speedFactor` (roads 1.5x vehicles / 1.15x foot), `buildableCircle` (placement: no trees / rocks / roads / buildings).
- Sim (`simulation.ts`): `planMove` = one A* per mover class group, units join the route by LOS (`joinRoute`) and finish on their formation spot; `paths: Map<entityId, PathState>`
  (saved in snapshots, version 3); `revalidatePaths` re-plans routes a new structure blocks; no nav in `FLAT_WORLD` (straight lines, used by sim-check's synthetic tests).
  `commandRejected` reason `noPath` when unreachable. Spawn / rally moves are routed too.
- Debug (debug panel): "Show AI paths" and "Walkable layer" (`render/game/navDebug.ts`, driven by `GameController.setDebugPaths / setWalkable`; works without a running game).
- sim-check section 5c generates a real map: base-to-base routes, no blocked samples, road share, AI units off obstacles, paths survive save/load.

# AI (`ai/player.ts`)
Command-only controller: every ~1.5-4 s (by level, staggered per player) builds from `BUILD_ORDER` (power first when short), queues infantry/tanks,
and sends idle unengaged army to the nearest enemy structure (leaning towards the human) once `waveSize` is reached.

# Session / UI
- `GameSession(terrain, level)`: spawns, per base slot, an instant Command Center + 6 riflemen + 2 tanks; slot 0 is the human; credits 6000 each.
- `GameController` (src/ui): picking (units by screen distance, structures by footprint), box select, orders (RMB), placement ghost, control groups
  (Ctrl+1-9), H = base, P = pause, Del = sell, minimap, `hudState()`. HUD = Alpine `gameHud` (src/ui/hud.ts, markup `#hud` in index.html, hud.css), separate from the debug `mapPanel`;
  while playing `body.game-active` hides the debug panel unless F2 / Debug button (`show-debug`).
- Engine hooks: `addToScene`, `addFrameHook(dt)`, `canvas`, `viewCamera`, `heightAt`, `focusOn`.

# Rendering (placeholder, `render/game/`)
`GameLayer`: one `InstancedMesh` per unit/structure type (Lambert + vertex colours × team instance colour), translucent full-height volume while a structure
rises (scale.y = synced progress), selection rings, health bars (camera-facing instanced quads), tracers (LineSegments), markers, placement ghost.
Positions of moving units are extrapolated with their velocity since the last transform batch. **Known debt vs core rules 5/6**: no per-unit LOD/skeletal
animation (plan P2), no light halos/transient lights, no explosion particles, no shadow LOD for units; add before real content.

# Verify
`pnpm sim-check` (determinism, save/load, replica==sim, late joiner progress, 4-AI skirmish, Jolt heightfield) + `pnpm typecheck`; browser via CDP (skill `testing-workflow`).
