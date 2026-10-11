// Map scale: the one constant that sizes the generated world. Change `MAP_SCALE` and everything follows:
//   - the app generates a play area of `MAP_SIZE` cells per side (engine.ts)
//   - towns grow with the map: a city's radius (so its area, by `MAP_SCALE`) and the plant's distance from it use `linearScale`
//   - the countryside fills up with it: a web of rural roads grows with the extra area (`areaScale`, roads/network.ts), and the
//     buildings along the roads get denser (`linearScale`, buildings.ts), with their poles and lamps following the roads
//   - how many cities, rivers, plants, landmarks and bridges there are does NOT change; sizes of everything else (buildings,
//     bases, plants, roads) stay in metres. Distances measured against the map (base spacing, noise wavelengths, ranges) already
//     work from the play area's span.
// Generation is bit-identical to the unscaled generator for maps no bigger than the reference (both scales are never < 1).

/** Area of the world relative to the reference map (`REFERENCE_SIZE` cells per side): 1 = 640x640 cells (~1.28 km), 4 = 1280x1280 (~2.56 km). */
export const MAP_SCALE = 1;

/** Play area side (cells) of the reference map (scale 1) and the cell size (metres) the app uses. */
export const REFERENCE_SIZE = 640;
export const MAP_CELL = 2;

/** Play area side (cells) the app generates. */
export const MAP_SIZE = Math.round(REFERENCE_SIZE * Math.sqrt(MAP_SCALE));

/** Side length of a play area of `size` cells relative to the reference map, never below 1. */
export function linearScale(size: number): number {
  return Math.max(1, size / REFERENCE_SIZE);
}

/** Area of a play area of `size` cells per side relative to the reference map, never below 1. */
export function areaScale(size: number): number {
  return linearScale(size) ** 2;
}
