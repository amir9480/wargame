---
name: terrain-roads
description: Road and railway network generation (modules/roads/*) - crossings, exits and tunnels, network growth and junction normal forms, shaping, carving, intersection pads, output types and the graph API for AI. Load before changing anything in modules/roads/ or code that reads Terrain.roads.
---

# Roads (`src/terrain/modules/roads/`)

- `crossings.ts`: plans 2–4 crossing sites per river (narrow, gentle dry banks, straight 3–5 cell approaches). **Roads may cross water only inside these corridors**, one road per crossing.
- `sites.ts`: 0–2 map exits at the lowest point of the grid's outer land edges. Where a range stands on the edge (`exitSite`) the exit is a **tunnel portal** at its foot (first cell inward past the ridge with `mountain` ≤ `TUNNEL_MOUNTAIN` 10 m), reached by a straight 8-cell approach; railway ends too. `RoadNode.tunnel` = true. Carving leaves ground past the portal plane alone and raises a cut-and-cover mound; renderer draws headwall + opening + wing walls (`render/tunnels.ts`).
- `network.ts` (A*/Dijkstra via `pathfind.ts`):
  1. **Ring** between bases (slot order 0→1→2→3→0). Routes reuse existing road (cost ×0.35); only off-road stretches become new edges, joined with junctions ⇒ roads merge, never cross.
  2. Exits joined to nearest road. 3. Rivers with < `MIN_BRIDGES` (2) used crossings get crossing roads. 4. Disconnected pieces joined to the main network (last resort may bridge anywhere).
  - **Dead-end tidy** (`tidyDeadEnds`, no rng): dry dead-end junctions are linked straight on (≤ 18 cells, within 60°) to the nearest valid road; facing dead ends merge; otherwise dropped if < 15 cells; repeated.
  - **Close town junctions** (`mergeCloseJunctions`): twin roads < 7 cells apart lose the dirt / longer one; junctions < 15 cells apart merge (kept node = fewer roads moved; skipped if > 4 arms); `dropRemovedEdges` renumbers.
  - **Junction normal form** (before shaping / meshes): `dissolveJoins` turns every 2-road junction of one type into one continuous edge; a dirt road meeting a town street is first paved up to a dry split point beyond `TOWN_REACH`. `straightenArms`: every road leaves a 3- / 4-way junction as a straight chord for 8 cells so plates, crosswalks, stop lines match the ribbons.
  - Constraints: max grade 0.3 while routing, shore buffer (1 cell) outside corridors, junctions only on dry ground, snap to end nodes, no short dead ends. Ring roads asphalt with 40% chance, everything else dirt.
  5. **Railway** (`rail.ts`, own stream `STAGE.rails`, so roads are unchanged): 50% chance on maps with ≥ 2 land sides; one line between two land edges (opposite preferred), routed after the roads. May bridge any river, never the sea or a used crossing; avoids bases (+6 cells), penalises grade (max 0.45) and running within 5 cells of roads; steps onto road cells square-ish (`RAIL_CROSS_COS`), dry, ≥ 5 cells from any node; smoothed once (min radius 10 cells), split at road intersections into `crossing` nodes.
- `shape.ts`: smoothing (RDP → Chaikin → resample 1 cell → relax → min radius 3 cells), **never onto water**, once per road *before* junction splits. Surface profile capped at 0.25 grade (rail 0.07; `railNodeHeights`); bridges = wet runs + 2 abutment points, arched deck.
- `carve.ts`: cells under a road take the nearest surface point's height; shoulders take the strongest cut/fill; never fills water, leaves ground under bridge decks. Rail cuttings/embankments are wider. Town asphalt levels its full sidewalk width too; levelled cells return as `RoadResult.level` (`ctx.roadLevel`).
- **Intersection pads**: junctions and level crossings get a flat pad at the node height (radius = widest half-width + `PAD_MARGIN` 2 cells, blended over 4), every meeting edge level for pad radius + 1 cells.
- **Bases outrank roads**: `RoadContext.keep` = base squares; carving never touches them; profiles inside a base are pinned to the levelled ground (`releasePins`).
- Output `RoadNetwork { nodes, edges }` in world units: node kinds `base | exit | junction | crossing`, edge types `dirt | asphalt | rail`; edge `{ id, from, to, type, width, points[{x,y,z}], length, bridges[{start,end,length,river}] }` (points ~1 cell apart; `ROAD_WIDTH`: dirt 3.2, asphalt 5.5, rail 3.6).
- `graph.ts` (for AI): `findRoadRoute`, `nearestRoadNode`, `nearestRoadPoint`, `roadNeighbors`, `edgePointsFrom`. Rail is not driveable by default (`speed.rail = 0`); nearest-road queries skip rail.
- Health numbers to watch: bridges per river (~14% of rivers get < 2), connectivity from node 0, off-bridge road points over water (0), max grade, min turn radius, short town junction edges.
