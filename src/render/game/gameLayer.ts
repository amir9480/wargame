// Draws the replica (ClientState): units and structures as instanced placeholder models (one draw call per type),
// selection rings, health bars, tracers, order markers and the placement ghost. Reads the replica only.
// Placeholder-level: no per-unit LOD / animation yet (plan phase P2); all meshes have identity transforms, hand-culled off.
import * as THREE from 'three';
import { STRUCTURES } from '../../game/defs/structures.ts';
import { UNITS, UNIT_BY_ID, UNIT_SCALE } from '../../game/defs/units.ts';
import { hash32 } from '../../core/rng.ts';
import { entityIndex } from '../../game/store/entities.ts';
import type { GameSession } from '../../game/session.ts';
import { SNAPSHOT_EVERY, TICK_DT } from '../../game/tuning.ts';
import type { Environment } from '../world.ts';
import { createGameMaterial, withShade } from './material.ts';
import { structureGeometry, unitGeometry, UNIT_HEIGHT } from './models.ts';

import { PLAYER_COLORS } from '../bases.ts'; // one palette for the base borders and every game object
export { PLAYER_COLORS };
const MAX_UNITS = 2048;
const MAX_STRUCTURES = 96;
const MAX_RINGS = 1024;
const MAX_BARS = 768;
const MAX_TRACERS = 384;
const SHOT_LIFE = 0.14;

export interface Ghost { type: number; x: number; z: number; yaw: number; valid: boolean }

const dummy = new THREE.Object3D();
const color = new THREE.Color();

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, max: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, max);
  m.count = 0;
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.setColorAt(0, color.set(0xffffff)); // allocates instanceColor
  m.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  return m;
}

export class GameLayer {
  readonly group = new THREE.Group();
  private units = new Map<number, THREE.InstancedMesh>();
  private structures = new Map<number, THREE.InstancedMesh>();
  private ghostBoxes: THREE.InstancedMesh;
  private rings: THREE.InstancedMesh;
  private barBack: THREE.InstancedMesh;
  private barFill: THREE.InstancedMesh;
  private tracers: THREE.LineSegments;
  private markers: Array<{ x: number; z: number; t: number }> = [];
  private ghost: THREE.Group;
  private ghostMat: THREE.ShaderMaterial;
  private ghostMeshes = new Map<number, THREE.Mesh>();
  private shots: Array<{ ax: number; ay: number; az: number; bx: number; by: number; bz: number; t: number }> = [];
  private heightAt: (x: number, z: number) => number;

  /** Fogged / environment-lit materials of this layer: register them with the world (Engine.addFogMaterial) so fog follows the camera. */
  readonly materials: THREE.ShaderMaterial[] = [];

  constructor(heightAt: (x: number, z: number) => number, env: Environment) {
    this.heightAt = heightAt;
    const unitMat = createGameMaterial(env);
    const ghostVolumeMat = createGameMaterial(env, { unlit: true, opacity: 0.16 });
    const ringMat = createGameMaterial(env, { unlit: true, opacity: 0.9, side: THREE.DoubleSide });
    const tracerMat = createGameMaterial(env, { unlit: true, opacity: 0.95 });
    ghostVolumeMat.polygonOffset = true; // drawn behind the real structure and the ground where they touch
    ghostVolumeMat.polygonOffsetFactor = 2;
    ghostVolumeMat.polygonOffsetUnits = 2;
    this.ghostMat = createGameMaterial(env, { unlit: true, opacity: 0.45 });
    this.materials.push(unitMat, ghostVolumeMat, ringMat, tracerMat, this.ghostMat);
    for (const u of UNITS) {
      const m = instanced(unitGeometry(u.name), unitMat, MAX_UNITS);
      this.units.set(u.id, m);
      this.group.add(m);
    }
    for (const s of STRUCTURES) {
      const m = instanced(structureGeometry(s.name), unitMat, MAX_STRUCTURES);
      this.structures.set(s.id, m);
      this.group.add(m);
    }
    // translucent full-size volume shown while a structure is still rising
    this.ghostBoxes = instanced(withShade(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), ghostVolumeMat, MAX_STRUCTURES);
    this.group.add(this.ghostBoxes);

    const ring = withShade(new THREE.RingGeometry(0.85, 1.0, 28).rotateX(-Math.PI / 2));
    this.rings = instanced(ring, ringMat, MAX_RINGS);
    this.rings.renderOrder = 5;
    this.group.add(this.rings);

    const bar = new THREE.PlaneGeometry(1, 1);
    this.barBack = instanced(bar, new THREE.MeshBasicMaterial({ color: 0x101418, depthTest: false, transparent: true, opacity: 0.8 }), MAX_BARS);
    this.barFill = instanced(bar.clone(), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }), MAX_BARS);
    this.barBack.renderOrder = 10; this.barFill.renderOrder = 11;
    this.group.add(this.barBack, this.barFill);

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6).fill(1), 3));
    lg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6).fill(0), 3));
    tracerMat.uniforms.tint.value.set(0xffd36b);
    this.tracers = new THREE.LineSegments(lg, tracerMat);
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 6;
    this.group.add(this.tracers);

    this.ghost = new THREE.Group();
    this.ghost.visible = false;
    for (const s of STRUCTURES) {
      const g = new THREE.Mesh(structureGeometry(s.name), this.ghostMat);
      g.scale.set(s.width, s.height, s.depth);
      g.visible = false;
      this.ghostMeshes.set(s.id, g);
      this.ghost.add(g);
    }
    this.group.add(this.ghost);
    this.group.updateMatrixWorld(true);
  }

  /** A short-lived "go here" marker on the ground. */
  addMarker(x: number, z: number): void {
    this.markers.push({ x, z, t: 0 });
  }

  update(session: GameSession, camera: THREE.Camera, selected: ReadonlySet<number>, ghost: Ghost | null, dt: number, hover = -1): void {
    const client = session.client;
    const s = client.store;
    // render time since the last transform batch (pose is extrapolated with the unit's velocity)
    const batchTick = Math.floor(client.tick / SNAPSHOT_EVERY) * SNAPSHOT_EVERY;
    const ahead = Math.min(0.2, (client.tick - batchTick) * TICK_DT + session.fraction);

    const counts = new Map<number, number>();
    let nRing = 0, nBar = 0, nGhostBox = 0;
    const camQ = camera.quaternion;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i]) continue;
      const type = s.type[i];
      const owner = s.owner[i];
      const id = s.idAt(i);
      const isStructure = type >= 100;
      const mesh = isStructure ? this.structures.get(type) : this.units.get(type);
      if (!mesh) continue;
      const n = counts.get(type) ?? 0;
      if (n >= mesh.instanceMatrix.count) continue;
      counts.set(type, n + 1);

      let x = s.x[i], z = s.z[i];
      let h: number;
      if (isStructure) {
        const def = STRUCTURES.find((d) => d.id === type)!;
        const p = client.structureProgress(i, session.fraction);
        const rise = Math.max(0.04, p);
        dummy.position.set(x, s.y[i], z);
        dummy.rotation.set(0, s.yaw[i], 0);
        dummy.scale.set(def.width, def.height * rise, def.depth);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        color.set(PLAYER_COLORS[owner] ?? 0xffffff).multiplyScalar(0.55 + 0.45 * p);
        mesh.setColorAt(n, color);
        if (p < 0.999 && nGhostBox < MAX_STRUCTURES) {
          // slightly larger than the structure so their faces never coincide (z-fighting)
          dummy.scale.set(def.width * 1.06, def.height * 1.04, def.depth * 1.06);
          dummy.updateMatrix();
          this.ghostBoxes.setMatrixAt(nGhostBox, dummy.matrix);
          this.ghostBoxes.setColorAt(nGhostBox, color.set(PLAYER_COLORS[owner] ?? 0xffffff));
          nGhostBox++;
        }
        h = def.height + 3;
        if (selected.has(id) || i === hover) {
          if (nRing < MAX_RINGS) { this.setRing(nRing++, x, s.y[i] + 0.3, z, Math.max(def.width, def.depth) * 0.62, 0xffffff); }
        }
      } else {
        x += s.vx[i] * ahead; z += s.vz[i] * ahead;
        const y = this.heightAt(x, z);
        dummy.position.set(x, y, z);
        dummy.rotation.set(0, s.yaw[i], 0);
        dummy.scale.setScalar(UNIT_SCALE);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        mesh.setColorAt(n, color.set(PLAYER_COLORS[owner] ?? 0xffffff));
        const def = UNIT_BY_ID.get(type)!;
        h = (UNIT_HEIGHT[def.name] ?? 2) * UNIT_SCALE + 0.6;
        if (selected.has(id) || i === hover) {
          if (nRing < MAX_RINGS) this.setRing(nRing++, x, y + 0.25, z, def.radius * UNIT_SCALE * 1.5 + 0.4, selected.has(id) ? 0xffffff : 0xffe28a);
        }
      }

      // health bar: selected or damaged entities only
      const maxHp = isStructure ? STRUCTURES.find((d) => d.id === type)!.hp : UNIT_BY_ID.get(type)!.hp;
      const frac = s.hp[i] / maxHp;
      if ((selected.has(id) || frac < 0.999) && nBar < MAX_BARS) {
        const w = isStructure ? 4 : 1.3;
        dummy.position.set(x, (isStructure ? s.y[i] : this.heightAt(x, z)) + h, z);
        dummy.quaternion.copy(camQ);
        dummy.scale.set(w, 0.28, 1);
        dummy.updateMatrix();
        this.barBack.setMatrixAt(nBar, dummy.matrix);
        this.barBack.setColorAt(nBar, color.set(0xffffff));
        dummy.scale.set(Math.max(0.001, w * frac * 0.94), 0.2, 1);
        dummy.updateMatrix();
        this.barFill.setMatrixAt(nBar, dummy.matrix);
        this.barFill.setColorAt(nBar, color.setHSL(0.33 * Math.min(1, frac * 1.15), 0.9, 0.5));
        nBar++;
        dummy.rotation.set(0, 0, 0);
      }
    }
    dummy.quaternion.identity();
    for (const [type, mesh] of [...this.units, ...this.structures]) {
      mesh.count = counts.get(type) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
    this.ghostBoxes.count = nGhostBox;
    this.ghostBoxes.instanceMatrix.needsUpdate = true;
    this.ghostBoxes.instanceColor!.needsUpdate = true;

    // order markers
    for (const m of this.markers) {
      m.t += dt;
      if (nRing < MAX_RINGS) this.setRing(nRing++, m.x, this.heightAt(m.x, m.z) + 0.3, m.z, 0.6 + m.t * 3.2, 0x7dff9a);
    }
    this.markers = this.markers.filter((m) => m.t < 0.6);

    this.rings.count = nRing;
    this.rings.instanceMatrix.needsUpdate = true;
    this.rings.instanceColor!.needsUpdate = true;
    this.barBack.count = this.barFill.count = nBar;
    for (const b of [this.barBack, this.barFill]) { b.instanceMatrix.needsUpdate = true; b.instanceColor!.needsUpdate = true; }

    this.updateTracers(session, dt);
    this.updateGhost(ghost);
  }

  private setRing(n: number, x: number, y: number, z: number, r: number, c: number): void {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(r, 1, r);
    dummy.updateMatrix();
    this.rings.setMatrixAt(n, dummy.matrix);
    this.rings.setColorAt(n, color.set(c));
  }

  private updateTracers(session: GameSession, dt: number): void {
    const client = session.client;
    const s = client.store;
    for (const shot of client.shots) {
      if (!s.isValid(shot.from) || !s.isValid(shot.to)) continue;
      const a = entityIndex(shot.from), b = entityIndex(shot.to);
      const fromUnit = s.type[a] < 100;
      const j = hash32(shot.from, shot.tick); // seeded jitter: the aim point wanders a little around the target
      this.shots.push({
        ax: s.x[a], ay: s.y[a] + (fromUnit ? 1.3 : 3), az: s.z[a],
        bx: s.x[b] + ((j & 255) / 255 - 0.5) * 1.6, by: s.y[b] + 1.1, bz: s.z[b] + (((j >>> 8) & 255) / 255 - 0.5) * 1.6, t: 0,
      });
    }
    client.shots.length = 0;
    const pos = this.tracers.geometry.attributes.position as THREE.BufferAttribute;
    let n = 0;
    for (const sh of this.shots) {
      sh.t += dt;
      if (n >= MAX_TRACERS) break;
      // a short streak travelling from the muzzle to the target
      const f1 = Math.min(1, sh.t / SHOT_LIFE), f0 = Math.max(0, f1 - 0.35);
      pos.setXYZ(n * 2, sh.ax + (sh.bx - sh.ax) * f0, sh.ay + (sh.by - sh.ay) * f0, sh.az + (sh.bz - sh.az) * f0);
      pos.setXYZ(n * 2 + 1, sh.ax + (sh.bx - sh.ax) * f1, sh.ay + (sh.by - sh.ay) * f1, sh.az + (sh.bz - sh.az) * f1);
      n++;
    }
    this.shots = this.shots.filter((sh) => sh.t < SHOT_LIFE);
    pos.needsUpdate = true;
    this.tracers.geometry.setDrawRange(0, n * 2);
  }

  private updateGhost(g: Ghost | null): void {
    this.ghost.visible = !!g;
    if (!g) return;
    for (const [id, mesh] of this.ghostMeshes) mesh.visible = id === g.type;
    const mesh = this.ghostMeshes.get(g.type);
    if (!mesh) return;
    mesh.position.set(g.x, this.heightAt(g.x, g.z), g.z);
    mesh.rotation.y = g.yaw;
    this.ghostMat.uniforms.tint.value.set(g.valid ? 0x40ff80 : 0xff4d4d);
    mesh.updateMatrix();
    this.group.updateMatrixWorld(true);
  }
}
