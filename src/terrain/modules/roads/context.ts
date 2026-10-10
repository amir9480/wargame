// Shared input and grid-space working types for the road sub-modules.

import type { GridPoint, PlayArea, Point, Side } from '../../types.ts';
import type { RoadNodeKind, RoadType } from './types.ts';

export interface RoadContext {
  N: number;
  cell: number;
  /** Playable part of the grid: river crossings are planned inside it. */
  play: PlayArea;
  heights: Float32Array;
  /** Height the relief's mountains add per cell. */
  mountain: Float32Array;
  /** 1 - normal.y per cell. */
  slope: Float32Array;
  /** River id + 1 on carved river beds, else 0. */
  riverMask: Uint8Array;
  /** 1 on mountain stream channels (water above sea level): no road / railway crosses them. */
  streamMask: Uint8Array;
  /** 1 within a few cells of a river. */
  nearRiver: Uint8Array;
  /** Crossing id + 1 on planned river-crossing corridors (the only water roads may cross). */
  corridor: Int16Array;
  seaSides: Side[];
  /** 1 inside player base build areas: levelled before the roads and kept as they are (roads follow that ground). */
  keep: Uint8Array;
}

/** Player base: centre cell and half side of its square build area, in cells. */
export interface BaseSite extends GridPoint {
  half: number;
}

/** A city's street grid (grid coordinates): crossing points and streets between them (node index pairs). */
export interface CityStreets extends GridPoint {
  /** Radius of the built-up area, cells. */
  radius: number;
  nodes: Point[];
  streets: [number, number][];
}

/** Node during network growth, in (fractional) grid coordinates. */
export interface GridNode {
  id: number;
  x: number;
  y: number;
  kind: RoadNodeKind;
  edges: number[];
}

/** Edge during network growth: smoothed centre line in fractional grid coordinates. */
export interface GridEdge {
  id: number;
  from: number;
  to: number;
  type: RoadType;
  /** ~1 cell apart; pts[0] at `from`, last at `to`. */
  pts: Point[];
}
