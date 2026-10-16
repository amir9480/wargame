// Debug views for navigation (debug panel): a very faint walkable-area overlay for one mover class (green walkable, cyan road,
// yellow rough / forest, red blocked) and the A* routes the units are following (one colour per player). Not game content:
// built on demand, drawn through the same fog as the map, never part of the sim.
import * as THREE from 'three';
import { UNIT_BY_ID } from '../../game/defs/units.ts';
import type { Mover, NavGrid } from '../../game/nav/navgrid.ts';
import { COST_ROAD } from '../../game/nav/navgrid.ts';
import type { GameSession } from '../../game/session.ts';
import { entityIndex } from '../../game/store/entities.ts';
import { PLAYER_COLORS } from '../bases.ts';
import type { Environment } from '../world.ts';
import vertexShader from '../shaders/navdebug.vert.glsl';
import fragmentShader from '../shaders/navdebug.frag.glsl';
import { createGameMaterial } from './material.ts';

const LIFT = 1.0;
const MAX_SEGMENTS = 20000;
/** Mask alphas: deliberately faint, the overlay must not hide the map. */
const ALPHA = { walkable: 28, road: 46, rough: 36, blocked: 22 };

export class NavDebugLayer {
  readonly group = new THREE.Group();
  readonly materials: THREE.ShaderMaterial[] = [];
  private overlay: THREE.Mesh | null = null;
  private overlayMat: THREE.ShaderMaterial;
  private texture: THREE.DataTexture | null = null;
  private mode: Mover | 'off' = 'off';
  private builtFor: { nav: NavGrid; mode: Mover; epoch: number } | null = null;
  private lines: THREE.LineSegments;
  private lineMat: THREE.ShaderMaterial;
  private lineAcc = 1;
  private heightAt: (x: number, z: number) => number;
  private worldSize: number;

  constructor(env: Environment, worldSize: number, heightAt: (x: number, z: number) => number) {
    this.heightAt = heightAt;
    this.worldSize = worldSize;
    this.overlayMat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: {
        tMask: { value: null },
        opacity: { value: 1 },
        navOrigin: { value: -worldSize / 2 },
        navSize: { value: worldSize },
        ...env.fog,
        fogNear: { value: 400 },
        fogFar: { value: 1200 },
      },
    });
    this.lineMat = createGameMaterial(env, { unlit: true, opacity: 0.95 });
    this.lineMat.depthTest = false; // routes stay visible over rises and buildings
    this.materials.push(this.overlayMat, this.lineMat);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 6), 3));
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 30;
    this.lines.visible = false;
    this.group.add(this.lines);
  }

  /** Walkable overlay for a mover class (or off). Rebuilds the mask when the class, the grid or its structures change. */
  setWalkable(mode: Mover | 'off', nav: NavGrid | null): void {
    this.mode = nav ? mode : 'off';
    if (this.mode === 'off' || !nav) {
      if (this.overlay) this.overlay.visible = false;
      return;
    }
    const b = this.builtFor;
    if (b && b.nav === nav && b.mode === this.mode && b.epoch === nav.epoch) {
      if (this.overlay) this.overlay.visible = true;
      return;
    }
    this.buildMask(nav, this.mode);
    this.builtFor = { nav, mode: this.mode, epoch: nav.epoch };
    if (this.overlay) this.overlay.visible = true;
  }

  private buildMask(nav: NavGrid, mode: Mover): void {
    const n = nav.n;
    const data = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      let r: number, g: number, b: number, a: number;
      if (nav.road[i] && nav.passable(mode, i)) { r = 40; g = 220; b = 255; a = ALPHA.road; }
      else if (!nav.passable(mode, i)) { r = 255; g = 60; b = 60; a = ALPHA.blocked; }
      else if (nav.cost[mode][i] > 10 && nav.cost[mode][i] > COST_ROAD) { r = 255; g = 214; b = 60; a = ALPHA.rough; }
      else { r = 60; g = 255; b = 90; a = ALPHA.walkable; }
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
    }
    if (!this.texture || this.texture.image.width !== n) {
      this.texture?.dispose();
      this.texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
      this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
      this.texture.generateMipmaps = false;
      this.texture.colorSpace = THREE.NoColorSpace;
      this.overlayMat.uniforms.tMask.value = this.texture;
    } else {
      (this.texture.image.data as Uint8Array).set(data);
    }
    this.texture.needsUpdate = true;
    if (!this.overlay) this.buildOverlayMesh(nav);
  }

  /** One plane over the whole map, vertices on the ground (every second nav cell) so it follows the relief. */
  private buildOverlayMesh(nav: NavGrid): void {
    const seg = Math.ceil(nav.n / 2);
    const geo = new THREE.PlaneGeometry(this.worldSize, this.worldSize, seg, seg).rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, this.heightAt(p.getX(i), p.getZ(i)) + LIFT);
    const mesh = new THREE.Mesh(geo, this.overlayMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 0.9;
    this.overlay = mesh;
    this.group.add(mesh);
  }

  /** Routes of the units of the given owners, refreshed ~5x per second. */
  updatePaths(on: boolean, session: GameSession | null, owners: (o: number) => boolean, dt: number): void {
    this.lines.visible = on && !!session;
    if (!on || !session) return;
    this.lineAcc += dt;
    if (this.lineAcc < 0.2) return;
    this.lineAcc = 0;
    const s = session.sim.store;
    const pos = this.lines.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.lines.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    let n = 0;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      if (n >= MAX_SEGMENTS) return;
      pos.setXYZ(n * 2, ax, ay, az); pos.setXYZ(n * 2 + 1, bx, by, bz);
      col.setXYZ(n * 2, c.r, c.g, c.b); col.setXYZ(n * 2 + 1, c.r, c.g, c.b);
      n++;
    };
    for (const [id, path] of session.sim.paths) {
      if (!s.isValid(id)) continue;
      const i = entityIndex(id);
      if (!owners(s.owner[i]) || !UNIT_BY_ID.has(s.type[i])) continue;
      c.set(PLAYER_COLORS[s.owner[i]] ?? 0xffffff).multiplyScalar(1.3);
      let px = s.x[i], pz = s.z[i], py = this.heightAt(px, pz) + 1.4;
      for (let k = path.i; k * 2 < path.pts.length; k++) {
        const x = path.pts[k * 2], z = path.pts[k * 2 + 1], y = this.heightAt(x, z) + 1.4;
        seg(px, py, pz, x, y, z);
        px = x; pz = z; py = y;
      }
      seg(px, py, pz, px, py + 7, pz); // a post at the destination
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, n * 2);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.overlay?.geometry.dispose();
    this.lines.geometry.dispose();
    this.texture?.dispose();
    for (const m of this.materials) m.dispose();
  }
}
