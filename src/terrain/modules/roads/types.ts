// Public road network data. Everything is in world units (map centred on the
// origin, y up), so game code and AI can use it directly.

/** `rail` is a railway track: part of the same network (bridges, level crossings), but not driveable. */
export type RoadType = 'dirt' | 'asphalt' | 'rail';

/**
 * - base:     a player base (centre of its build area)
 * - exit:     road or railway leaves the map here (on the grid's outer edge, or into a tunnel at a range's foot)
 * - junction: where one road joins another
 * - crossing: level crossing, where a road crosses the railway (two road edges + two rail edges)
 */
export type RoadNodeKind = 'base' | 'exit' | 'junction' | 'crossing';

export interface RoadPoint {
  x: number;
  /** Road surface height (bridge deck height on bridges). */
  y: number;
  z: number;
}

export interface RoadNode extends RoadPoint {
  id: number;
  kind: RoadNodeKind;
  /** Ids of edges meeting at this node. */
  edges: number[];
  /** Exit only: the road / railway enters a tunnel portal here, at the foot of a mountain range (its edge arrives heading in). */
  tunnel?: boolean;
}

/** A bridge span: points[start..end] of its edge (inclusive), both ends on dry land. */
export interface Bridge {
  start: number;
  end: number;
  /** Span length in world units. */
  length: number;
  /** Index of the river it crosses (into Terrain.rivers). */
  river: number;
}

export interface RoadEdge {
  id: number;
  /** Node ids; points[0] is at `from`, points[last] is at `to`. */
  from: number;
  to: number;
  type: RoadType;
  /** Paved / driven width in world units. */
  width: number;
  /** Curve nodes of the road centre line, ~one grid cell apart. */
  points: RoadPoint[];
  /** Length in world units. */
  length: number;
  bridges: Bridge[];
}

export interface RoadNetwork {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

/** Driven width; for rail the ballast bed (standard gauge track on it). */
export const ROAD_WIDTH: Readonly<Record<RoadType, number>> = { dirt: 3.2, asphalt: 5.5, rail: 3.6 };
