import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleGrid, type RoadEdge, type RoadNetwork, type RoadType, type Terrain } from '../terrain/generate.ts';
import type { Environment, TerrainTextures } from './world.ts';
import { splitByChunk, type ChunkGrid } from './culling.ts';
import { CROSSWALK, CURB_GAP, SIDEWALK_WIDTH, STOP_LINE, STOP_LINE_GAP, crosswalkEnds, planIntersections, townAt } from '../terrain/urban.ts';
import roadVertex from './shaders/road.vert.glsl';
import roadFragment from './shaders/road.frag.glsl';
import bridgeVertex from './shaders/bridge.vert.glsl';
import bridgeFragment from './shaders/bridge.frag.glsl';

/** Ribbon extends this far past the road width so edges can fade into the ground. */
const MARGIN = 0.8;
/** Ribbon height above the ground, against z-fighting. */
const LIFT = 0.1;
/** Draw order: the railway last, so its rails show on top of roads at level crossings. */
const ROAD_TYPES: RoadType[] = ['dirt', 'asphalt', 'rail'];
/** Asphalt edge line and gravel shoulder, inset from the road's half width (match road.frag.glsl). */
const EDGE_LINE = 0.8;
const SHOULDER = 0.55;
/** Two roads at a node count as one road passing through when their directions are at least this opposite. */
const THROUGH_DOT = 0.85;
/** Side road markings start this far (m) past the edge line of the road they join. */
const CLIP_MARGIN = 0.6;
/** Lane markings fade out between these camera distances (m) and are not computed beyond: a few cm of paint
 * there is well under a pixel. */
const MARK_FADE_START = 140;
const MARK_FADE_END = 220;

const BRIDGE_STYLE: Record<RoadType, { deck: number; rail: number; pier: number; pierSize: number }> = {
  dirt: { deck: 0x6b4e33, rail: 0x57402a, pier: 0x4a3622, pierSize: 0.3 }, // timber
  asphalt: { deck: 0x8f8d88, rail: 0xb3b1ab, pier: 0x7a7874, pierSize: 0.6 }, // concrete
  rail: { deck: 0x5d5853, rail: 0x3b3936, pier: 0x77736d, pierSize: 0.8 }, // steel girders on stone piers
};
/** At a level crossing the ballast stops this far (m) beyond the road's edge; only the rails go on across. */
const CROSSING_MARGIN = 0.4;

/** Road ribbons (one mesh per road type, the railway included) and bridge structures. */
export class RoadLayer {
  readonly group = new THREE.Group();
  readonly materials: THREE.ShaderMaterial[];
  private roadMats: Record<RoadType, THREE.ShaderMaterial>;
  /** Second asphalt pass: bare pavement laid over every road's shoulder, so junctions read as one surface. */
  private pavementMat: THREE.ShaderMaterial;
  private bridgeMat: THREE.ShaderMaterial;

  constructor(textures: TerrainTextures, env: Environment) {
    const lighting = () => ({
      sunDir: { value: env.sunDir },
      sunColor: { value: env.sunColor },
      skyAmbient: { value: env.skyAmbient },
      groundAmbient: { value: env.groundAmbient },
      ...env.fog,
      fogNear: { value: 400 },
      fogFar: { value: 1200 },
    });
    const roadMat = (defines: Record<string, string>) =>
      new THREE.ShaderMaterial({
        vertexShader: roadVertex,
        fragmentShader: roadFragment,
        defines: {
          ...defines,
          CROSSWALK: CROSSWALK.toFixed(2),
          STOP_LINE_START: (CROSSWALK + STOP_LINE_GAP).toFixed(2),
          STOP_LINE_END: (CROSSWALK + STOP_LINE_GAP + STOP_LINE).toFixed(2),
          MARK_FADE_START: MARK_FADE_START.toFixed(1),
          MARK_FADE_END: MARK_FADE_END.toFixed(1),
          CURB_GAP: CURB_GAP.toFixed(2),
          SIDEWALK_OUTER: (CURB_GAP + SIDEWALK_WIDTH).toFixed(2),
        },
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        uniforms: {
          tDirt: { value: textures.dirt },
          tGrass: { value: textures.grass },
          tAsphalt: { value: textures.asphalt },
          halfWidth: { value: 1 },
          ...lighting(),
        },
      });
    this.roadMats = { dirt: roadMat({}), asphalt: roadMat({ ASPHALT: '' }), rail: roadMat({ RAIL: '' }) };
    this.pavementMat = roadMat({ ASPHALT: '', PAVEMENT: '' });
    this.bridgeMat = new THREE.ShaderMaterial({
      vertexShader: bridgeVertex,
      fragmentShader: bridgeFragment,
      vertexColors: true,
      uniforms: { tRock: { value: textures.rock }, ...lighting() },
    });
    this.materials = [this.roadMats.dirt, this.roadMats.asphalt, this.roadMats.rail, this.pavementMat, this.bridgeMat];
  }

  /** Road ribbons and bridges split into per-chunk meshes, so the culler can skip off-screen chunks. */
  build(terrain: Terrain, grid: ChunkGrid): void {
    for (const step of this.steps(terrain, grid)) step();
  }

  /** Removes the old roads, then returns the build as separate steps (one per road type, then bridges) to run in order. */
  steps(terrain: Terrain, grid: ChunkGrid): (() => void)[] {
    this.clear();
    const { edges } = terrain.roads;
    const offsets = dashOffsets(terrain.roads);
    // Town intersections: crosswalk + stop line on every road arriving there.
    const crossings = crosswalkEnds(planIntersections(terrain));

    const steps = ROAD_TYPES.map((type, order) => () => {
      const ofType = edges.filter((e) => e.type === type);
      if (!ofType.length) return;
      this.roadMats[type].uniforms.halfWidth.value = ofType[0].width / 2;
      if (type === 'asphalt') this.pavementMat.uniforms.halfWidth.value = ofType[0].width / 2;
      // Built whole (normals and dash distances stay continuous), then cut into chunks.
      // Caps and ribbons get their own render order: chunk meshes of equal order are
      // sorted by distance, which would draw some caps over ribbons.
      buildRoadGeometry(terrain, type, ofType, offsets, crossings).forEach((geo, layer) => {
        for (const part of splitByChunk(geo, grid)) {
          const mesh = new THREE.Mesh(part, this.roadMats[type]);
          // After terrain, before water; asphalt over dirt where they meet.
          mesh.renderOrder = 0.5 + order * 0.1 + layer * 0.01;
          this.group.add(mesh);
          if (type !== 'asphalt') continue;
          // Pavement over all the shoulders, so joins read as one surface.
          const pavement = new THREE.Mesh(part, this.pavementMat);
          pavement.renderOrder = mesh.renderOrder + 0.05;
          this.group.add(pavement);
        }
        geo.dispose();
      });
    });

    steps.push(() => {
      const bridges = buildBridges(terrain, edges);
      if (!bridges) return;
      for (const part of splitByChunk(bridges, grid)) this.group.add(new THREE.Mesh(part, this.bridgeMat));
      bridges.dispose();
    });
    return steps;
  }

  clear(): void {
    // Pavement meshes share their geometry with the asphalt ribbon mesh (dispose is idempotent).
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      this.group.remove(child);
    }
  }
}

function groundAt(t: Terrain, x: number, z: number): number {
  const half = t.worldSize / 2;
  return sampleGrid(t.heights, t.size, (x + half) / t.cell, (z + half) / t.cell);
}

/** Unit horizontal direction of an edge leaving node `nodeId`. */
function leaving(e: RoadEdge, nodeId: number): [number, number] {
  const pts = e.from === nodeId ? e.points : [...e.points].reverse();
  const a = pts[0], b = pts[Math.min(2, pts.length - 1)];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return [(b.x - a.x) / len, (b.z - a.z) / len];
}

/** Two same-type edges leaving a node in opposite directions (within `dot`) are one road passing through. */
function isContinuation(a: RoadEdge, b: RoadEdge, nodeId: number, dot = 0.97): boolean {
  const [ax, az] = leaving(a, nodeId), [bx, bz] = leaving(b, nodeId);
  return a.type === b.type && ax * bx + az * bz < -dot;
}

/**
 * Starting "along" distance per edge, so lane dashes run on unbroken where a
 * road was split by a junction (the tail continues from the head's length).
 */
function dashOffsets(net: RoadNetwork): Map<number, number> {
  const memo = new Map<number, number>();
  const offset = (e: RoadEdge): number => {
    const known = memo.get(e.id);
    if (known !== undefined) return known;
    memo.set(e.id, 0); // cycle guard
    const prev = net.nodes[e.from].edges
      .map((id) => net.edges[id])
      .find((f) => f.id !== e.id && f.to === e.from && isContinuation(e, f, e.from, THROUGH_DOT));
    const value = prev ? offset(prev) + prev.length : 0;
    memo.set(e.id, value);
    return value;
  };
  for (const e of net.edges) offset(e);
  return memo;
}

/** Where lane markings stop at one end of an edge, in metres from the node. */
interface MarkingClip {
  /** All markings off this close to the node (a side road ends at the road it joins). */
  all: number;
  /** Edge line on the +side / -side off this close (where a side road opens off a through road). */
  pos: number;
  neg: number;
  /** Pavement pass skipped this close (the part of a side road inside the through road's pavement). */
  skip: number;
}
const NO_CLIP: MarkingClip = { all: 0, pos: 0, neg: 0, skip: 0 };

/**
 * Lane marking clips at each end of each edge, so junctions look like real ones:
 * a through road keeps its markings, except the edge line across a side road's
 * mouth; a side road's markings end at the through road's edge line. Where no road
 * passes through, every road's markings end at the others' edge lines.
 */
function markingClips(net: RoadNetwork, type: RoadType): Map<number, [MarkingClip, MarkingClip]> {
  const clips = new Map<number, [MarkingClip, MarkingClip]>();
  for (const e of net.edges) if (e.type === type) clips.set(e.id, [{ ...NO_CLIP }, { ...NO_CLIP }]);
  if (type === 'rail') return railClips(net, clips);
  if (type !== 'asphalt') return clips; // only asphalt is painted
  const line = (e: RoadEdge) => e.width / 2 - EDGE_LINE; // edge line offset from the centre
  const paved = (e: RoadEdge) => e.width / 2 - SHOULDER; // pavement half width
  const maxClip = (e: RoadEdge) => e.width * 2.5;

  for (const node of net.nodes) {
    const here = node.edges.map((id) => net.edges[id]).filter((e) => e.type === type);
    if (here.length < 2) continue;
    const dirs = here.map((e) => leaving(e, node.id));
    const clipOf = (k: number) => clips.get(here[k].id)![here[k].from === node.id ? 0 : 1];
    // Through road: the most nearly opposite pair, if it is close to straight.
    let through: [number, number] | null = null;
    let best = -THROUGH_DOT;
    for (let a = 0; a < here.length; a++)
      for (let b = a + 1; b < here.length; b++) {
        const d = dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1];
        if (d < best) [best, through] = [d, [a, b]];
      }
    for (let i = 0; i < here.length; i++) {
      const [ix, iz] = dirs[i];
      const clip = clipOf(i);
      if (through && through.includes(i)) {
        // Through road: open the edge line where each side road crosses it.
        // Side vector of the ribbon at this end (the ribbon runs from -> to).
        const flip = here[i].from === node.id ? 1 : -1;
        const sx = -iz * flip, sz = ix * flip;
        for (let j = 0; j < here.length; j++) {
          if (through.includes(j)) continue;
          const [jx, jz] = dirs[j];
          const cos = ix * jx + iz * jz, sin = Math.max(0.25, Math.abs(ix * jz - iz * jx));
          const end = Math.min(maxClip(here[i]), (line(here[i]) * cos + paved(here[j])) / sin);
          if (end <= 0) continue;
          if (jx * sx + jz * sz > 0) clip.pos = Math.max(clip.pos, end);
          else clip.neg = Math.max(clip.neg, end);
        }
        continue;
      }
      // Side road (or no through road): markings end just past the other roads' edge lines.
      for (let j = 0; j < here.length; j++) {
        if (j === i || (through && !through.includes(j))) continue;
        const [jx, jz] = dirs[j];
        const cos = Math.abs(ix * jx + iz * jz), sin = Math.max(0.25, Math.abs(ix * jz - iz * jx));
        clip.all = Math.max(clip.all, Math.min(maxClip(here[i]), (line(here[j]) + line(here[i]) * cos) / sin + CLIP_MARGIN));
        // Inside the through road's pavement the through road is drawn (with its markings), whatever the draw order.
        if (through) clip.skip = Math.max(clip.skip, Math.max(0, (paved(here[j]) - paved(here[i]) * cos) / sin - 0.1));
      }
    }
  }
  return clips;
}

/**
 * Railway clips: at a level crossing the ballast and sleepers end at the road's edge (`all`),
 * so only the rails are drawn across the road surface.
 */
function railClips(net: RoadNetwork, clips: Map<number, [MarkingClip, MarkingClip]>): Map<number, [MarkingClip, MarkingClip]> {
  for (const node of net.nodes) {
    if (node.kind !== 'crossing') continue;
    const here = node.edges.map((id) => net.edges[id]);
    const roads = here.filter((e) => e.type !== 'rail');
    for (const rail of here.filter((e) => e.type === 'rail')) {
      const [rx, rz] = leaving(rail, node.id);
      let clip = 0;
      for (const road of roads) {
        const [ox, oz] = leaving(road, node.id);
        const sin = Math.max(0.3, Math.abs(rx * oz - rz * ox));
        clip = Math.max(clip, (road.width / 2 + CROSSING_MARGIN) / sin + (rail.width / 2) * Math.abs(rx * ox + rz * oz) / sin);
      }
      clips.get(rail.id)![rail.from === node.id ? 0 : 1].all = clip;
    }
  }
  return clips;
}

/** Vertex streams of one road layer (see buildRoadGeometry for the attributes). */
class RoadBuffers {
  pos: number[] = [];
  road: number[] = [];
  ends: number[] = [];
  gaps: number[] = [];
  skip: number[] = [];
  cross: number[] = [];
  walk: number[] = [];
  junc: number[] = [];
  juncW: number[] = [];
  /** Junction plate data pushed with every vertex (see buildPlate). */
  curJunc = NO_JUNC;
  curJuncW = NO_ENDS;
  index: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(
    x: number, y: number, z: number, road: number[], ends = NO_ENDS, gaps = NO_ENDS, skip = NO_SKIP, cross = NO_SKIP, walk = NO_WALK,
  ): void {
    this.pos.push(x, y, z);
    this.cross.push(...cross);
    this.walk.push(...walk);
    this.junc.push(...this.curJunc);
    this.juncW.push(...this.curJuncW);
    this.road.push(...road);
    this.ends.push(...ends);
    this.gaps.push(...gaps);
    this.skip.push(...skip);
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(this.road, 3));
    geo.setAttribute('aEnds', new THREE.Float32BufferAttribute(this.ends, 4));
    geo.setAttribute('aGaps', new THREE.Float32BufferAttribute(this.gaps, 4));
    geo.setAttribute('aSkip', new THREE.Float32BufferAttribute(this.skip, 2));
    geo.setAttribute('aCross', new THREE.Float32BufferAttribute(this.cross, 2));
    geo.setAttribute('aWalk', new THREE.Float32BufferAttribute(this.walk, 3));
    geo.setAttribute('aJunc', new THREE.Float32BufferAttribute(this.junc, 4));
    geo.setAttribute('aJuncW', new THREE.Float32BufferAttribute(this.juncW, 4));
    geo.setIndex(this.index);
    geo.computeVertexNormals();
    return geo;
  }
}
const NO_ENDS = [0, 0, 0, 0];
const NO_SKIP = [0, 0];
const NO_WALK = [0, 0, 0];
/** Unused junction plate direction slot (angle > 50 = none). */
const NO_JUNC = [99, 99, 99, 99];

/**
 * Road geometry in draw order: round caps where roads of this type meet at an angle
 * or dead-end (so joins have no gaps), then the ribbons along each road.
 * aRoad = (across, along, paint) in world units; paint = 0 turns lane markings off
 * (caps). aEnds = (distance from the start node, distance to the end node,
 * markings-off distance at start, at end); aGaps = edge-line gaps (start +side,
 * start -side, end +side, end -side); aSkip = pavement pass skipped within this of
 * (start, end); see markingClips. aCross = crosswalk start distance from (start, end) node, 0 = none (town
 * intersections, see terrain/urban.ts): zebra stripes, then the stop line on the arriving lane. aWalk = (town, sidewalk
 * start, end): town asphalt is drawn wider, with a curb and sidewalk painted flat beyond the carriageway (same ribbon,
 * same height), from `start` m after the start node to `end` m before the end node (the crosswalks).
 */
function buildRoadGeometry(
  t: Terrain, type: RoadType, edges: RoadEdge[], offsets: Map<number, number>, crossings: Map<number, [number, number]>,
): THREE.BufferGeometry[] {
  const clips = markingClips(t.roads, type);
  // Lane markings stop before a crosswalk's stop line.
  if (type === 'asphalt')
    for (const [id, ends] of crossings) {
      const c = clips.get(id);
      if (!c) continue;
      ends.forEach((d, end) => {
        if (d > 0) c[end].all = Math.max(c[end].all, d + CROSSWALK + STOP_LINE_GAP + STOP_LINE + 0.4);
      });
    }

  // Caps at nodes (not map exits) unless the road just passes straight through.
  const caps = new RoadBuffers();
  const capW = edges[0].width / 2 + MARGIN;
  for (const node of t.roads.nodes) {
    if (node.kind === 'exit' || type === 'rail') continue; // track joins are always straight through
    const here = node.edges.map((id) => t.roads.edges[id]).filter((e) => e.type === type);
    if (!here.length) continue;
    if (here.length === 2 && isContinuation(here[0], here[1], node.id)) continue;
    if (type === 'asphalt' && townAt(t.cities, node.x, node.z) >= 0) {
      buildPlate(caps, t, node, crossings);
      continue;
    }
    const center = caps.count;
    caps.vertex(node.x, node.y + LIFT, node.z, [0, 0, 0]);
    const SEGMENTS = 20;
    for (let k = 0; k < SEGMENTS; k++) {
      const a = (k / SEGMENTS) * Math.PI * 2;
      const x = node.x + Math.cos(a) * capW, z = node.z + Math.sin(a) * capW;
      caps.vertex(x, Math.max(node.y, groundAt(t, x, z)) + LIFT, z, [capW, 0, 0]);
      // counter-clockwise seen from above
      caps.index.push(center, center + 1 + ((k + 1) % SEGMENTS), center + 1 + k);
    }
  }

  const out = new RoadBuffers();
  for (const e of edges) {
    const [cs, ce] = clips.get(e.id)!;
    const pts = e.points;
    const w = e.width / 2 + MARGIN;
    const base = out.count;
    let along = offsets.get(e.id) ?? 0;
    let fromStart = 0;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const gaps = [cs.pos, cs.neg, ce.pos, ce.neg];
    const skip = [cs.skip, ce.skip];
    const cross = type === 'asphalt' ? crossings.get(e.id) ?? NO_SKIP : NO_SKIP;
    const walkW = e.width / 2 + CURB_GAP + SIDEWALK_WIDTH + 0.15;
    const prevEdge: [number, number][] = [];
    pts.forEach((p, i) => {
      if (i) {
        const step = Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
        along += step;
        fromStart += step;
      }
      // Tangent over a wider window: keeps the ribbon from folding on tight bends.
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len;
      const sx = -tz, sz = tx; // horizontal side vector
      const bridge = e.bridges.some((br) => i > br.start && i < br.end);
      const ends = [fromStart, total - fromStart, cs.all, ce.all];
      // Town street: wider ribbon carrying the sidewalks (none on bridges).
      const town = type === 'asphalt' && !e.bridges.some((br) => i >= br.start - 1 && i <= br.end + 1) && townAt(t.cities, p.x, p.z) >= 0;
      const wp = town ? walkW : w;
      const walk = town ? [1, cross[0], cross[1]] : NO_WALK;
      // Three columns across: left edge, centre, right edge.
      [-1, 0, 1].forEach((s, col) => {
        let x = p.x + sx * wp * s, z = p.z + sz * wp * s;
        // Inner edge of a tight bend would run backwards and fold: hold it in place instead.
        const prev = prevEdge[col];
        if (s && prev && (x - prev[0]) * tx + (z - prev[1]) * tz < 0) [x, z] = prev;
        prevEdge[col] = [x, z];
        // Never dip under the ground (cut edges, small bumps); bridges stay on the deck.
        const y = bridge ? p.y : Math.max(p.y, groundAt(t, x, z));
        out.vertex(x, y + LIFT, z, [wp * s, along, 1], ends, gaps, skip, cross, walk);
      });
      if (i) {
        const prev = base + (i - 1) * 3, cur = base + i * 3;
        for (let c = 0; c < 2; c++) {
          // counter-clockwise seen from above
          out.index.push(prev + c, prev + c + 1, cur + c, prev + c + 1, cur + c + 1, cur + c);
        }
      }
    });
  }
  return [caps, out].filter((b) => b.count).map((b) => b.geometry());
}

/**
 * Town junction / dead-end plate: one flat polygon over the node (same lift and depth bias as the ribbons) that the
 * road shader paints as carriageway where a road runs (aJunc = up to 4 road directions as angles, aJuncW = their half
 * widths) and as curb + paving elsewhere, so the sidewalks of the meeting streets join round the corners.
 * The polygon reaches each road's crosswalk (or its sidewalk's outer edge); a dead end gets a round turning circle.
 * aRoad.xy = offset from the node, aWalk.x = 2 (junction) / 3 (dead end).
 */
/** Neighbouring plate arms closer than this (radians) get their block corner; wider gaps a rounded open side. */
const PLATE_CORNER_MAX = Math.PI - 0.05;

function buildPlate(b: RoadBuffers, t: Terrain, node: RoadNetwork['nodes'][number], crossings: Map<number, [number, number]>): void {
  const roads = node.edges.map((id) => t.roads.edges[id]).filter((e) => e.type !== 'rail');
  const arms = roads
    .map((e) => {
      const d = leaving(e, node.id);
      const hw = e.width / 2;
      const cross = crossings.get(e.id)?.[e.from === node.id ? 0 : 1] ?? 0;
      return { d, hw, outer: hw + CURB_GAP + SIDEWALK_WIDTH, reach: cross > 0 ? cross : hw + CURB_GAP + SIDEWALK_WIDTH, angle: Math.atan2(d[1], d[0]) };
    })
    .sort((p, q) => p.angle - q.angle)
    .slice(0, 4);
  const pad = (v: number[], fill: number) => [...v, fill, fill, fill, fill].slice(0, 4);
  b.curJunc = pad(arms.map((a) => a.angle), 99);
  b.curJuncW = pad(arms.map((a) => a.hw), 0);
  const y = (x: number, z: number) => Math.max(node.y, groundAt(t, x, z)) + LIFT;
  const center = b.count;
  const flag = arms.length === 1 ? 3 : 2;
  b.vertex(node.x, node.y + LIFT, node.z, [0, 0, 0], NO_ENDS, NO_ENDS, NO_SKIP, NO_SKIP, [flag, 0, 0]);
  const rim: [number, number][] = [];
  if (arms.length === 1) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      rim.push([Math.cos(a) * arms[0].outer, Math.sin(a) * arms[0].outer]);
    }
  } else {
    arms.forEach((a, i) => {
      const [dx, dz] = a.d, nx = -dz, nz = dx; // n: towards increasing angle
      rim.push([dx * a.reach - nx * a.outer, dz * a.reach - nz * a.outer], [dx * a.reach + nx * a.outer, dz * a.reach + nz * a.outer]);
      // Block corner between this road's +side sidewalk edge and the next road's -side one. A plain chord would cut
      // inside the corner, and across a gap of 180 degrees or more (the open side of a T) behind the node, folding the fan.
      const b = arms[(i + 1) % arms.length];
      let gap = b.angle - a.angle;
      if (gap <= 0) gap += Math.PI * 2;
      if (gap < PLATE_CORNER_MAX) {
        const [ex, ez] = b.d, mx = -ez, mz = ex;
        // s * d_a + outer_a * n_a = t * d_b - outer_b * n_b
        const px = -mx * b.outer - nx * a.outer, pz = -mz * b.outer - nz * a.outer;
        const den = dx * -ez - dz * -ex;
        const s = (px * -ez - pz * -ex) / den;
        const cx = dx * s + nx * a.outer, cz = dz * s + nz * a.outer;
        if (s > 0 && Math.hypot(cx, cz) < 4 * Math.max(a.outer, b.outer)) rim.push([cx, cz]);
      } else {
        // Open side (a T's far kerb, or wider): along each sidewalk edge back to beside the node, round between.
        rim.push([nx * a.outer, nz * a.outer]);
        const from = a.angle + Math.PI / 2, to = a.angle + gap - Math.PI / 2;
        const steps = Math.ceil((to - from) / 0.3);
        for (let k = 1; k < steps; k++) {
          const ang = from + ((to - from) * k) / steps, r = a.outer + ((b.outer - a.outer) * k) / steps;
          rim.push([Math.cos(ang) * r, Math.sin(ang) * r]);
        }
        rim.push([b.d[1] * b.outer, -b.d[0] * b.outer]);
      }
    });
  }
  rim.forEach(([ox, oz]) => b.vertex(node.x + ox, y(node.x + ox, node.z + oz), node.z + oz, [ox, oz, 0], NO_ENDS, NO_ENDS, NO_SKIP, NO_SKIP, [flag, 0, 0]));
  // counter-clockwise seen from above (rim in increasing angle)
  for (let k = 0; k < rim.length; k++) b.index.push(center, center + 1 + ((k + 1) % rim.length), center + 1 + k);
  b.curJunc = NO_JUNC;
  b.curJuncW = NO_ENDS;
}

/** Deck, railings and piers for every bridge span, merged into one geometry. */
function buildBridges(t: Terrain, edges: RoadEdge[]): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3();
  const frame = new THREE.Matrix4();
  const color = new THREE.Color();

  const box = (w: number, h: number, d: number, offset: THREE.Vector3, m: THREE.Matrix4, hex: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.deleteAttribute('uv');
    g.translate(offset.x, offset.y, offset.z).applyMatrix4(m);
    color.set(hex);
    const c = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < c.length; i += 3) c.set([color.r, color.g, color.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
  };

  for (const e of edges) {
    const style = BRIDGE_STYLE[e.type];
    const deckW = e.width + 0.8;
    const railX = deckW / 2 - 0.1;
    for (const br of e.bridges) {
      for (let i = br.start; i < br.end; i++) {
        const p = e.points[i], q = e.points[i + 1];
        a.set(p.x, p.y, p.z);
        b.set(q.x, q.y, q.z);
        const len = a.distanceTo(b) + 0.06;
        // Local frame: z along the segment, y up-ish (follows the arch).
        frame.lookAt(a, b, up).setPosition(mid.addVectors(a, b).multiplyScalar(0.5));
        box(deckW, 0.4, len, new THREE.Vector3(0, -0.22, 0), frame, style.deck);
        box(0.16, 0.55, len, new THREE.Vector3(-railX, 0.3, 0), frame, style.rail);
        box(0.16, 0.55, len, new THREE.Vector3(railX, 0.3, 0), frame, style.rail);
        box(0.26, 0.85, 0.26, new THREE.Vector3(-railX, 0.2, len / 2), frame, style.rail);
        box(0.26, 0.85, 0.26, new THREE.Vector3(railX, 0.2, len / 2), frame, style.rail);

        // Piers every few points, where there is room under the deck.
        if ((i - br.start) % 3 !== 1) continue;
        const bed = groundAt(t, p.x, p.z) - 0.5;
        const top = p.y - 0.42;
        if (top - bed < 1) continue;
        // Vertical, turned to the road heading only (not the deck's arch).
        const pier = new THREE.Matrix4()
          .makeRotationY(Math.atan2(q.x - p.x, q.z - p.z))
          .setPosition(p.x, (top + bed) / 2, p.z);
        for (const s of [-1, 1]) {
          box(style.pierSize, top - bed, style.pierSize, new THREE.Vector3(s * e.width * 0.3, 0, 0), pier, style.pier);
        }
      }
    }
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}
