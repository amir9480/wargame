// Glue between the engine (camera, canvas, scene), the GameSession (sim + AI + replica), the GameLayer (drawing) and the
// HUD (Alpine). Holds NO Alpine state itself: the HUD polls `hudState()`, a small plain object. Input (selection, orders,
// structure placement) lives here too. Separate from the debug panel (`mapPanel`).
import * as THREE from 'three';
import type { Engine } from '../engine.ts';
import { hash32, type Rng } from '../core/rng.ts';
import type { Subject } from '../render/cinematicCamera.ts';
import { STRUCTURE_BY_ID, STRUCTURES, isStructureType } from '../game/defs/structures.ts';
import { UNITS, UNIT_BY_ID, UNIT_SCALE } from '../game/defs/units.ts';
import { entityIndex } from '../game/store/entities.ts';
import { GameSession } from '../game/session.ts';
import { isComplete } from '../game/sim/placement.ts';
import { REJECT_TEXT } from '../game/sim/messages.ts';
import { MAX_PLAYERS, TICK_RATE } from '../game/tuning.ts';
import { GameLayer, PLAYER_COLORS, type Ghost } from '../render/game/gameLayer.ts';
import { NavDebugLayer } from '../render/game/navDebug.ts';
import { NavGrid, type Mover } from '../game/nav/navgrid.ts';

export interface HudStructureButton { id: number; label: string; cost: number; enabled: boolean; why: string; building: boolean }
export interface HudProduceButton { unit: number; label: string; cost: number; enabled: boolean }
export interface HudState {
  active: boolean;
  credits: number;
  power: { produced: number; consumed: number; factor: number };
  structures: HudStructureButton[];
  /** My structures still rising: synced 0..1 value. */
  constructing: Array<{ id: number; label: string; progress: number }>;
  selection: { count: number; label: string; hp: number; maxHp: number; structure: boolean; id: number; progress: number } | null;
  produce: HudProduceButton[];
  queue: { label: string; progress: number; queued: number } | null;
  placing: string;
  toasts: Array<{ id: number; text: string }>;
  gameOver: 'won' | 'lost' | null;
  players: Array<{ slot: number; name: string; color: string; alive: boolean; structures: number; units: number }>;
  clock: string;
  paused: boolean;
  speed: number;
  debugMode: boolean;
}

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');
const PLAYER_NAMES = ['You', 'AI Red', 'AI Gold', 'AI Violet'];
const MINIMAP = 168;

export class GameController {
  session: GameSession | null = null;
  private layer: GameLayer | null = null;
  readonly selected = new Set<number>();
  private groups = new Map<number, number[]>();
  private placingType = 0;
  private ghost: Ghost | null = null;
  private hover = -1;
  private toasts: Array<{ id: number; text: string; t: number }> = [];
  private toastId = 0;
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  private selBox: HTMLElement | null;
  private minimapImage: HTMLCanvasElement | null = null;
  private raycaster = new THREE.Raycaster();
  private v = new THREE.Vector3();
  private lastClick = { t: 0, id: -1 };
  private engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
    this.selBox = document.getElementById('selbox');
    const canvas = engine.canvas;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));
    engine.addFrameHook((dt) => this.frame(dt));
  }

  get active(): boolean { return this.session !== null; }

  // ---- mode (game / debug view) -------------------------------------------------------------------------------
  /** Debug mode: view-only map (no session, no HUD / start menu, free RTS camera, debug panel always shown). */
  debugMode = false;
  /** Called with the new mode when it changes by user action (main.ts persists it). */
  onModeChange: ((mode: 'game' | 'debug') => void) | null = null;

  setDebugMode(on: boolean, persist = true): void {
    if (on) this.stop();
    this.debugMode = on;
    document.body.classList.toggle('debug-mode', on);
    if (persist) this.onModeChange?.(on ? 'debug' : 'game');
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------
  start(level: 'easy' | 'normal' | 'hard'): boolean {
    const terrain = this.engine.terrain;
    if (!terrain || this.debugMode) return false;
    this.stop();
    this.session = new GameSession(terrain, level);
    // units are drawn at the sim's standing height (bridge decks included), not the bare terrain
    this.layer = new GameLayer((x, z) => this.session?.world.heightAt(x, z) ?? this.engine.heightAt(x, z), this.engine.environment);
    for (const m of this.layer.materials) this.engine.addFogMaterial(m); // same fog / haze as the map
    this.engine.addToScene(this.layer.group);
    this.buildMinimap(terrain);
    this.engine.dayCycleSpeed = 1;
    this.selected.clear();
    const cc = this.myBase();
    // RTS view over the base, looking towards the map centre.
    if (cc) this.engine.cameraView = { x: cc.x, z: cc.z, yaw: Math.atan2(cc.x, cc.z), pitch: 0.95, distance: 190 };
    return true;
  }

  stop(): void {
    if (this.layer) {
      for (const m of this.layer.materials) { this.engine.removeFogMaterial(m); m.dispose(); }
      this.layer.group.removeFromParent();
      this.layer = null;
    }
    this.session = null;
    this.engine.dayCycleSpeed = 1;
    this.selected.clear();
    this.cancelPlacing();
  }

  private myBase(): { x: number; z: number } | null {
    const s = this.session?.client.store;
    if (!s) return null;
    for (let i = 0; i < s.highWater; i++) if (s.alive[i] && s.owner[i] === 0 && s.type[i] === 100) return { x: s.x[i], z: s.z[i] };
    return null;
  }

  focusBase(): void {
    const b = this.myBase();
    if (b) this.engine.focusOn(b.x, b.z);
  }

  togglePause(): void { if (this.session) this.session.paused = !this.session.paused; }
  setSpeed(v: number): void {
    if (!this.session) return;
    this.session.speed = v;
    this.engine.dayCycleSpeed = v; // the day / night clock follows the game speed
  }

  // ---- per-frame ----------------------------------------------------------------------------------------------
  /** True while a menu covers the game: start menu (no game), pause menu, or the game over screen. */
  get menuOpen(): boolean {
    const s = this.session;
    return !s || s.paused || s.gameOver !== null;
  }

  /** What the cinematic camera (pause menu) films next: my / enemy bases and armies, map buildings, towns, landmarks, power sites. */
  private pickSubject = (rng: Rng): Subject | null => {
    const session = this.session, terrain = this.engine.terrain;
    const roll = rng();
    if (session && roll < 0.45) {
      const s = session.client.store;
      for (let tries = 0; tries < 16 && s.count > 0; tries++) {
        const i = Math.floor(rng() * s.highWater);
        if (!s.alive[i]) continue;
        if (isStructureType(s.type[i])) {
          const d = STRUCTURE_BY_ID.get(s.type[i])!;
          return { x: s.x[i], y: s.y[i], z: s.z[i], radius: Math.max(d.width, d.depth) / 2 + 12 };
        }
        return { x: s.x[i], y: s.y[i], z: s.z[i], radius: 9 };
      }
    }
    if (terrain && roll < 0.8) {
      const pick = <T>(list: T[]): T | null => (list.length ? list[Math.floor(rng() * list.length)] : null);
      switch (Math.floor(rng() * 6)) {
        case 0: { const b = pick(terrain.buildings); if (b) return { x: b.x, y: b.y, z: b.z, radius: Math.max(b.width, b.depth) / 2 + b.height * 0.5 }; break; }
        case 1: { const c = pick(terrain.cities); if (c) return { x: c.x, y: c.y, z: c.z, radius: c.radius * 0.45 }; break; }
        case 2: {
          const l = pick(terrain.lighthouses);
          if (l) return { x: l.x, y: l.y, z: l.z, radius: l.height * 0.6 };
          break;
        }
        case 3: case 5: { // radio / radar towers on the mountains (two slots: they are rare on a map)
          const l = pick(terrain.towers);
          if (l) return { x: l.x, y: l.y + l.height * 0.35, z: l.z, radius: l.height * 0.7 };
          break;
        }
        default: { const p = pick(terrain.power.sites); if (p) return { x: p.x, y: p.y, z: p.z, radius: Math.max(p.width, p.depth) / 2 + 8 }; }
      }
    }
    return null; // CinematicCamera falls back to a random dry spot
  };

  // ---- debug views (debug panel) -------------------------------------------------------------------------------------
  /** Draw the A* routes AI units are following. */
  debugPaths = false;
  /** Faint walkable-area overlay for a mover class. */
  walkable: Mover | 'off' = 'off';
  private navDebug: NavDebugLayer | null = null;
  private navDebugTerrain: unknown = null;
  private cachedNav: NavGrid | null = null;

  setDebugPaths(on: boolean): void { this.debugPaths = on; }
  setWalkable(mode: Mover | 'off'): void { this.walkable = mode; }

  private updateNavDebug(dt: number): void {
    const terrain = this.engine.terrain;
    if (this.navDebugTerrain !== terrain) { // a new map (or none yet): the old overlay and grid describe another world
      this.navDebug?.materials.forEach((m) => this.engine.removeFogMaterial(m));
      this.navDebug?.dispose();
      this.navDebug = null;
      this.cachedNav = null;
      this.navDebugTerrain = terrain;
    }
    const wanted = this.debugPaths || this.walkable !== 'off';
    if (!terrain || (!wanted && !this.navDebug)) return;
    if (!this.navDebug) {
      this.navDebug = new NavDebugLayer(this.engine.environment, terrain.worldSize, (x, z) => this.engine.heightAt(x, z));
      this.navDebug.materials.forEach((m) => this.engine.addFogMaterial(m));
      this.engine.addToScene(this.navDebug.group);
    }
    const session = this.session;
    // The running game's grid (it includes player structures); otherwise a grid built just for the overlay.
    const nav = session?.world.nav ?? (this.walkable !== 'off' ? (this.cachedNav ??= new NavGrid(terrain)) : null);
    this.navDebug.setWalkable(this.walkable, nav);
    this.navDebug.updatePaths(this.debugPaths, session, () => true, dt);
  }

  private frame(dt: number): void {
    const session = this.session;
    this.updateNavDebug(dt);
    // Behind the start menu (once the map is built) and the pause menu a cinematic camera replaces the RTS camera.
    const terrain = this.engine.terrain;
    const cine = !!terrain && !this.debugMode && (!session || (session.paused && session.gameOver === null));
    if (cine !== this.engine.cinematicActive) this.engine.setCinematic(cine, hash32(terrain?.seed ?? 1, session?.client.tick ?? 0), this.pickSubject);
    this.engine.cameraEnabled = this.debugMode || !this.menuOpen; // no panning / rotating / zooming behind a menu
    if (!session || !this.layer) return;
    session.update(dt);
    const c = session.client;
    for (const r of c.rejections.splice(0)) if (r.player === 0) this.toast(REJECT_TEXT[r.reason] ?? 'Order rejected');
    for (const id of c.completed.splice(0)) {
      if (!c.store.isValid(id)) continue;
      const i = entityIndex(id);
      if (c.store.owner[i] === 0) this.toast(`${STRUCTURE_BY_ID.get(c.store.type[i])?.label ?? 'Structure'} complete`);
    }
    c.removed.length = 0;
    for (const id of [...this.selected]) if (!c.store.isValid(id)) this.selected.delete(id);
    this.hover = this.pointer.inside && !this.drag ? this.pickAt(this.pointer.x, this.pointer.y) : -1;
    if (this.placingType && this.pointer.inside) this.updateGhost(this.pointer.x, this.pointer.y);
    this.toasts = this.toasts.filter((t) => (t.t -= dt) > 0);
    this.layer.update(session, this.engine.viewCamera, this.selected, this.ghost, dt, this.hover >= 0 ? entityIndex(this.hover) : -1);
  }

  private toast(text: string): void {
    this.toasts.push({ id: ++this.toastId, text, t: 3.5 });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  // ---- picking ------------------------------------------------------------------------------------------------
  private ndc(px: number, py: number): THREE.Vector2 {
    const r = this.engine.canvas.getBoundingClientRect();
    return new THREE.Vector2(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1);
  }

  /** Ground point under a screen position (ray marched against the heightmap). */
  groundAt(px: number, py: number): { x: number; z: number } | null {
    const cam = this.engine.viewCamera;
    this.raycaster.setFromCamera(this.ndc(px, py), cam);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    if (d.y >= -1e-3) return null;
    let t = 0, prevT = 0;
    for (let n = 0; n < 1600; n++) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y <= this.engine.heightAt(x, z)) {
        let a = prevT, b = t;
        for (let k = 0; k < 8; k++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m <= this.engine.heightAt(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m;
        }
        return { x: o.x + d.x * b, z: o.z + d.z * b };
      }
      prevT = t;
      t += Math.max(2, t * 0.008);
    }
    return null;
  }

  /** Entity id under the cursor (units first, then structure footprints), or -1. */
  private pickAt(px: number, py: number): number {
    const session = this.session;
    if (!session) return -1;
    const cam = this.engine.viewCamera;
    const r = this.engine.canvas.getBoundingClientRect();
    const s = session.client.store;
    const k = r.height / (2 * Math.tan((cam.fov * Math.PI) / 360));
    let best = -1, bestScore = 1.25;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || isStructureType(s.type[i])) continue;
      const def = UNIT_BY_ID.get(s.type[i])!;
      this.v.set(s.x[i], s.y[i] + 1.1 * UNIT_SCALE, s.z[i]).project(cam);
      if (this.v.z > 1) continue;
      const sx = r.left + ((this.v.x + 1) / 2) * r.width, sy = r.top + ((1 - this.v.y) / 2) * r.height;
      const dist = cam.position.distanceTo(this.v.set(s.x[i], s.y[i], s.z[i]));
      const rad = Math.max(7, ((def.radius * UNIT_SCALE + 0.5) * k) / dist);
      const score = Math.hypot(sx - px, sy - py) / rad;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) return s.idAt(best);
    const g = this.groundAt(px, py);
    if (!g) return -1;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || !isStructureType(s.type[i])) continue;
      const def = STRUCTURE_BY_ID.get(s.type[i])!;
      if (Math.hypot(s.x[i] - g.x, s.z[i] - g.z) < Math.max(def.width, def.depth) * 0.55) return s.idAt(i);
    }
    return -1;
  }

  // ---- input --------------------------------------------------------------------------------------------------
  private onDown(e: PointerEvent): void {
    if (!this.session || this.menuOpen) return; // menus block selecting / ordering too
    this.pointer = { x: e.clientX, y: e.clientY, inside: true };
    if (e.button === 0) {
      if (this.placingType) { this.confirmPlacement(e.shiftKey); return; }
      this.drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    } else if (e.button === 2) {
      if (this.placingType) { this.cancelPlacing(); return; }
      this.order(e.clientX, e.clientY);
    }
  }

  private onMove(e: PointerEvent): void {
    const r = this.engine.canvas.getBoundingClientRect();
    this.pointer = { x: e.clientX, y: e.clientY, inside: e.target === this.engine.canvas && e.clientX >= r.left && e.clientX <= r.right };
    if (this.drag) {
      this.drag.x1 = e.clientX; this.drag.y1 = e.clientY;
      const b = this.dragRect();
      if (this.selBox) {
        const big = b.w > 5 || b.h > 5;
        this.selBox.style.display = big ? 'block' : 'none';
        this.selBox.style.left = `${b.x}px`; this.selBox.style.top = `${b.y}px`;
        this.selBox.style.width = `${b.w}px`; this.selBox.style.height = `${b.h}px`;
      }
    }
  }

  private dragRect(): { x: number; y: number; w: number; h: number } {
    const d = this.drag!;
    return { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
  }

  private onUp(e: PointerEvent): void {
    if (e.button !== 0 || !this.drag || !this.session) return;
    const rect = this.dragRect();
    this.drag = null;
    if (this.selBox) this.selBox.style.display = 'none';
    if (rect.w > 5 || rect.h > 5) this.boxSelect(rect, e.shiftKey);
    else this.clickSelect(e.clientX, e.clientY, e.shiftKey);
  }

  private clickSelect(px: number, py: number, add: boolean): void {
    const session = this.session!;
    const id = this.pickAt(px, py);
    const s = session.client.store;
    if (!add) this.selected.clear();
    if (id < 0) return;
    if (s.owner[entityIndex(id)] !== 0) { this.selected.clear(); this.selected.add(id); return; } // inspect an enemy
    const now = performance.now();
    if (now - this.lastClick.t < 350 && this.lastClick.id === id && !isStructureType(s.type[entityIndex(id)])) {
      // double click: all of my units of that type on screen
      const type = s.type[entityIndex(id)];
      const cam = this.engine.viewCamera;
      for (let i = 0; i < s.highWater; i++) {
        if (!s.alive[i] || s.owner[i] !== 0 || s.type[i] !== type) continue;
        this.v.set(s.x[i], s.y[i], s.z[i]).project(cam);
        if (Math.abs(this.v.x) < 1 && Math.abs(this.v.y) < 1 && this.v.z < 1) this.selected.add(s.idAt(i));
      }
    } else if (add && this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.lastClick = { t: now, id };
  }

  private boxSelect(r: { x: number; y: number; w: number; h: number }, add: boolean): void {
    const session = this.session!;
    const s = session.client.store;
    const cam = this.engine.viewCamera;
    const canvas = this.engine.canvas.getBoundingClientRect();
    if (!add) this.selected.clear();
    let units = 0;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || s.owner[i] !== 0 || isStructureType(s.type[i])) continue;
      this.v.set(s.x[i], s.y[i] + 1, s.z[i]).project(cam);
      if (this.v.z > 1) continue;
      const sx = canvas.left + ((this.v.x + 1) / 2) * canvas.width, sy = canvas.top + ((1 - this.v.y) / 2) * canvas.height;
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) { this.selected.add(s.idAt(i)); units++; }
    }
    if (units) return;
    // no units in the box: pick my structures in it
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i] || s.owner[i] !== 0 || !isStructureType(s.type[i])) continue;
      this.v.set(s.x[i], s.y[i] + 3, s.z[i]).project(cam);
      const sx = canvas.left + ((this.v.x + 1) / 2) * canvas.width, sy = canvas.top + ((1 - this.v.y) / 2) * canvas.height;
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) this.selected.add(s.idAt(i));
    }
  }

  private order(px: number, py: number): void {
    const session = this.session!;
    const s = session.client.store;
    const ids = [...this.selected].filter((id) => s.isValid(id) && s.owner[entityIndex(id)] === 0 && !isStructureType(s.type[entityIndex(id)]));
    if (!ids.length) return;
    const target = this.pickAt(px, py);
    let x: number, z: number;
    if (target >= 0 && s.owner[entityIndex(target)] !== 0) { const t = entityIndex(target); x = s.x[t]; z = s.z[t]; }
    else {
      const g = this.groundAt(px, py);
      if (!g) return;
      ({ x, z } = g);
    }
    session.send({ kind: 'move', player: 0, ids, x, z });
    this.layer?.addMarker(x, z);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.session) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (this.session.paused) {
      // pause menu: only Esc / P (resume) do anything
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') this.togglePause();
      return;
    }
    if (e.key === 'Escape') {
      if (this.placingType) this.cancelPlacing();
      else if (this.selected.size) this.selected.clear();
      else this.togglePause(); // nothing to cancel: open the pause menu
      return;
    }
    if (e.key === 'Delete') { this.sellSelected(); return; }
    if (e.key === 'h' || e.key === 'H') { this.focusBase(); return; }
    if (e.key === 'p' || e.key === 'P') { this.togglePause(); return; }
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (e.ctrlKey) { e.preventDefault(); this.groups.set(n, [...this.selected]); this.toast(`Group ${n} set`); }
      else {
        const g = this.groups.get(n);
        if (g) {
          const s = this.session.client.store;
          this.selected.clear();
          for (const id of g) if (s.isValid(id)) this.selected.add(id);
        }
      }
    }
  }

  // ---- placement ----------------------------------------------------------------------------------------------
  beginPlacing(type: number): void {
    if (!this.session || !STRUCTURE_BY_ID.has(type)) return;
    this.placingType = type;
    if (this.pointer.inside) this.updateGhost(this.pointer.x, this.pointer.y);
  }

  cancelPlacing(): void {
    this.placingType = 0;
    this.ghost = null;
  }

  private updateGhost(px: number, py: number): void {
    const g = this.groundAt(px, py);
    if (!g || !this.session) { this.ghost = null; return; }
    const yaw = Math.atan2(-g.x, -g.z); // front faces the map centre
    this.ghost = { type: this.placingType, x: g.x, z: g.z, yaw, valid: this.session.checkPlacement(this.placingType, g.x, g.z) === 0 };
  }

  private confirmPlacement(keep: boolean): void {
    const g = this.ghost;
    if (!g || !this.session) return;
    const why = this.session.checkPlacement(g.type, g.x, g.z);
    if (why) { this.toast(REJECT_TEXT[why] ?? 'Cannot build here'); return; }
    this.session.send({ kind: 'placeStructure', player: 0, type: g.type, x: g.x, z: g.z, yaw: g.yaw, instant: 0 });
    if (!keep) this.cancelPlacing();
  }

  // ---- HUD actions --------------------------------------------------------------------------------------------
  queueUnit(structure: number, unit: number): void {
    this.session?.send({ kind: 'queueProduction', player: 0, structure, unitType: unit });
  }

  cancelQueue(structure: number): void {
    this.session?.send({ kind: 'cancelProduction', player: 0, structure });
  }

  sellSelected(): void {
    const s = this.session?.client.store;
    if (!s) return;
    for (const id of this.selected) if (s.isValid(id) && s.owner[entityIndex(id)] === 0 && isStructureType(s.type[entityIndex(id)])) this.session!.send({ kind: 'sell', player: 0, id });
  }

  // ---- HUD state ----------------------------------------------------------------------------------------------
  hudState(): HudState {
    const session = this.session;
    const empty: HudState = {
      active: false, credits: 0, power: { produced: 0, consumed: 0, factor: 1 }, structures: [], constructing: [], selection: null, produce: [],
      queue: null, placing: '', toasts: [], gameOver: null, players: [], clock: '', paused: false, speed: 1,
      debugMode: this.debugMode,
    };
    if (!session) return empty;
    const c = session.client;
    const s = c.store;
    const have = new Set<number>();
    const building = new Set<number>();
    const constructing: HudState['constructing'] = [];
    const counts = Array.from({ length: MAX_PLAYERS }, () => ({ structures: 0, units: 0 }));
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i]) continue;
      const o = s.owner[i];
      if (isStructureType(s.type[i])) {
        counts[o].structures++;
        if (o !== 0) continue;
        if (isComplete(s, i)) have.add(s.type[i]);
        else { building.add(s.type[i]); constructing.push({ id: s.idAt(i), label: STRUCTURE_BY_ID.get(s.type[i])!.label, progress: c.structureProgress(i) }); }
      } else counts[o].units++;
    }
    const credits = c.credits[0];
    const structures = STRUCTURES.map<HudStructureButton>((d) => {
      const missing = d.requires.filter((r) => !have.has(r)).map((r) => STRUCTURE_BY_ID.get(r)!.label);
      const why = missing.length ? `Requires ${missing.join(', ')}` : credits < d.cost ? 'Not enough credits' : '';
      return { id: d.id, label: d.label, cost: d.cost, enabled: !why, why, building: building.has(d.id) };
    });

    // selection summary
    let selection: HudState['selection'] = null;
    let produce: HudProduceButton[] = [];
    let queue: HudState['queue'] = null;
    if (this.selected.size) {
      const ids = [...this.selected].filter((id) => s.isValid(id));
      if (ids.length) {
        const first = entityIndex(ids[0]);
        const structure = isStructureType(s.type[first]);
        const label = ids.length > 1 ? `${ids.length} units` : structure ? STRUCTURE_BY_ID.get(s.type[first])!.label : UNIT_BY_ID.get(s.type[first])!.label;
        const maxHp = structure ? STRUCTURE_BY_ID.get(s.type[first])!.hp : UNIT_BY_ID.get(s.type[first])!.hp;
        selection = {
          count: ids.length, label: s.owner[first] === 0 ? label : `Enemy ${label}`, hp: s.hp[first], maxHp, structure, id: ids[0],
          progress: structure ? c.structureProgress(first) : 1,
        };
        if (structure && ids.length === 1 && s.owner[first] === 0 && isComplete(s, first)) {
          produce = UNITS.filter((u) => u.producedBy === s.type[first]).map((u) => ({ unit: u.id, label: u.label, cost: u.cost, enabled: credits >= u.cost }));
          const p = c.production.get(ids[0]);
          if (p) queue = { label: UNIT_BY_ID.get(p.unit)!.label, progress: c.productionProgress(p), queued: p.queued };
        }
      }
    }
    const secs = Math.floor(c.tick / TICK_RATE);
    return {
      active: true,
      credits,
      power: { produced: c.produced[0], consumed: c.consumed[0], factor: c.powerFactor[0] },
      structures, constructing, selection, produce, queue,
      placing: this.placingType ? STRUCTURE_BY_ID.get(this.placingType)!.label : '',
      toasts: this.toasts.map((t) => ({ id: t.id, text: t.text })),
      gameOver: session.gameOver,
      players: counts.map((n, slot) => ({ slot, name: PLAYER_NAMES[slot], color: hex(PLAYER_COLORS[slot]), alive: !c.defeated.includes(slot), ...n })),
      clock: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
      paused: session.paused,
      speed: session.speed,
      debugMode: this.debugMode,
    };
  }

  // ---- minimap ------------------------------------------------------------------------------------------------
  private buildMinimap(t: NonNullable<Engine['terrain']>): void {
    const c = document.createElement('canvas');
    c.width = c.height = MINIMAP;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(MINIMAP, MINIMAP);
    const half = t.playSize / 2;
    for (let y = 0; y < MINIMAP; y++) for (let x = 0; x < MINIMAP; x++) {
      const wx = ((x + 0.5) / MINIMAP) * t.playSize - half, wz = ((y + 0.5) / MINIMAP) * t.playSize - half;
      const h = this.engine.heightAt(wx, wz);
      const o = (y * MINIMAP + x) * 4;
      let r: number, g: number, b: number;
      if (h <= 0.4) { r = 40; g = 90; b = 150; }
      else if (h > 70) { r = 215; g = 218; b = 224; }
      else if (h > 28) { r = 120 + h; g = 112 + h * 0.6; b = 100; }
      else { r = 60 + h * 1.2; g = 105 + h * 0.8; b = 55 + h * 0.4; }
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.minimapImage = c;
  }

  drawMinimap(canvas: HTMLCanvasElement): void {
    const session = this.session, t = this.engine.terrain;
    if (!session || !t || !this.minimapImage) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width, h = canvas.height;
    ctx.drawImage(this.minimapImage, 0, 0, w, h);
    const s = session.client.store;
    const half = t.playSize / 2;
    for (let i = 0; i < s.highWater; i++) {
      if (!s.alive[i]) continue;
      const px = ((s.x[i] + half) / t.playSize) * w, py = ((s.z[i] + half) / t.playSize) * h;
      const st = isStructureType(s.type[i]);
      ctx.fillStyle = hex(PLAYER_COLORS[s.owner[i]] ?? 0xffffff);
      ctx.fillRect(px - (st ? 2 : 1), py - (st ? 2 : 1), st ? 4 : 2, st ? 4 : 2);
    }
    const v = this.engine.cameraView;
    const cx = ((v.x + half) / t.playSize) * w, cy = ((v.z + half) / t.playSize) * h;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 9, cy - 6, 18, 12);
  }

  minimapClick(nx: number, ny: number): void {
    const t = this.engine.terrain;
    if (!t) return;
    this.engine.focusOn((nx - 0.5) * t.playSize, (ny - 0.5) * t.playSize);
  }
}
