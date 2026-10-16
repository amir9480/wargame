// Cinematic camera used behind the pause menu: hangs on a random subject (a base, an army, a town, a landmark, open land)
// for 5-10 s from a random side / elevation, drifting slowly, now and then spinning around the subject, then fades to black
// and cuts to the next subject. It only moves the camera; the RTS controller keeps its own state and takes over again on `stop`.
// Cosmetic randomness is seeded (`start(seed)`): the same seed gives the same sequence of shots.
import * as THREE from 'three';
import { mulberry32, type Rng } from '../core/rng.ts';

export interface Subject { x: number; y: number; z: number; radius: number }

const FADE = 0.8; // seconds of fade at each end of a shot
const MIN_SHOT = 5;
const MAX_SHOT = 10;

interface Shot {
  duration: number;
  yaw: number;
  pitch: number;
  distance: number;
  /** Radians / s around the subject (base drift; slow, or a continuous spin shot). */
  spin: number;
  /** Optional spin burst: starts at `burstAt` s, lasts `burstLen`, peak speed `burstSpeed` rad/s (eased). */
  burstAt: number;
  burstLen: number;
  burstSpeed: number;
  pitchDrift: number;
  dolly: number;
  drift: THREE.Vector2;
  lift: number;
  /** Height of the look-at point above the ground beneath it. */
  above: number;
}

/** `shots`: random subjects (menus); `overview`: slow high orbit over the whole map (while it generates). */
type Mode = 'off' | 'shots' | 'overview';

export class CinematicCamera {
  private mode: Mode = 'off';
  get active(): boolean {
    return this.mode !== 'off';
  }
  /** Point the camera looks at (culling / LOD follow it while active) and its distance from the camera. */
  readonly target = new THREE.Vector3();
  distance = 100;

  private camera: THREE.PerspectiveCamera;
  private heightAt: (x: number, z: number) => number;
  /** Picks the next subject; returns null when it has nothing (a random land point is used then). */
  subjects: (rng: Rng) => Subject | null = () => null;
  private rng: Rng = mulberry32(1);
  private shot: Shot | null = null;
  private t = 0;
  private focus = new THREE.Vector3();
  private focusY = 0;
  private yaw = 0;
  private pitch = 0.6;
  /** Current (smoothed) rotation speed, rad/s. */
  private spinNow = 0;
  private overlay: HTMLDivElement;
  private fade = 1;
  private bound: number;

  constructor(camera: THREE.PerspectiveCamera, heightAt: (x: number, z: number) => number, bound: number) {
    this.camera = camera;
    this.heightAt = heightAt;
    this.bound = bound;
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, { position: 'fixed', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none', zIndex: '15' });
    document.body.appendChild(this.overlay);
  }

  setBound(bound: number): void {
    this.bound = bound;
  }

  /** Begins the sequence (fading in from black on the first shot). */
  start(seed: number): void {
    this.rng = mulberry32(seed >>> 0);
    this.mode = 'shots';
    this.fade = 1;
    this.newShot();
  }

  /** Back to the RTS camera: a short fade in from black hides the jump. Leaves the generation overview alone. */
  stop(): void {
    if (this.mode !== 'shots') return;
    this.mode = 'off';
    this.fade = 1;
    this.shot = null;
  }

  /** While a map generates: a very far, slow orbit over the whole map instead of the RTS camera. */
  setOverview(on: boolean): void {
    if (on && this.mode === 'off') {
      this.mode = 'overview';
      this.shot = null;
      this.fade = 1;
      this.yaw = 0.6;
    } else if (!on && this.mode === 'overview') {
      this.mode = 'off';
      this.fade = 1;
    }
  }

  private updateOverview(dt: number): void {
    this.fade = Math.max(0, this.fade - dt / 1.2);
    this.applyFade();
    this.yaw += 0.02 * dt; // ~1.1 deg/s
    this.pitch = 0.62;
    this.distance = this.bound * 2.2;
    this.focus.set(0, 10, 0);
    this.target.copy(this.focus);
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.distance * cp * Math.sin(this.yaw),
      this.focus.y + this.distance * Math.sin(this.pitch),
      this.distance * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.focus);
  }

  update(dt: number): void {
    if (this.mode === 'overview') {
      this.updateOverview(dt);
      return;
    }
    if (this.mode !== 'shots' || !this.shot) {
      this.fade = Math.max(0, this.fade - dt / 0.5);
      this.applyFade();
      return;
    }
    const s = this.shot;
    this.t += dt;
    if (this.t >= s.duration) this.newShot();
    const sh = this.shot!;

    // fade: in over the first FADE s, out over the last FADE s
    const tIn = Math.min(1, this.t / FADE), tOut = Math.min(1, Math.max(0, (this.t - (sh.duration - FADE)) / FADE));
    this.fade = Math.max(1 - smooth(tIn), smooth(tOut));
    this.applyFade();

    // motion
    let spin = sh.spin;
    const u = (this.t - sh.burstAt) / sh.burstLen;
    if (sh.burstLen > 0 && u > 0 && u < 1) spin += sh.burstSpeed * Math.sin(Math.PI * u);
    // Ease the rotation in over the first seconds of a shot so it never starts with a jolt, then smooth the speed itself.
    const ease = smooth(Math.min(1, this.t / 2.5));
    this.spinNow += (spin * ease - this.spinNow) * (1 - Math.exp(-1.5 * dt));
    this.yaw += this.spinNow * dt;
    this.pitch = clamp(this.pitch + sh.pitchDrift * dt, 0.16, 1.35);
    this.distance = clamp(this.distance + sh.dolly * dt, 18, 320);
    // No play-area limit here: only the RTS camera is bounded (a shot may drift or look past the edge).
    this.focus.x += sh.drift.x * dt;
    this.focus.z += sh.drift.y * dt;
    // The focus keeps its height above the ground under it (a subject's own height, e.g. mid-mast, is part of the shot).
    const ground = Math.max(0, this.heightAt(this.focus.x, this.focus.z));
    this.focusY += (ground + sh.above - this.focusY) * (1 - Math.exp(-2 * dt));
    this.focus.y = this.focusY;
    this.target.copy(this.focus);

    const cp = Math.cos(this.pitch);
    const pos = this.camera.position;
    pos.set(
      this.focus.x + this.distance * cp * Math.sin(this.yaw),
      this.focus.y + this.distance * Math.sin(this.pitch),
      this.focus.z + this.distance * cp * Math.cos(this.yaw),
    );
    const minY = Math.max(0, this.heightAt(pos.x, pos.z)) + 3;
    if (pos.y < minY) pos.y = minY;
    this.camera.lookAt(this.focus);
  }

  private applyFade(): void {
    this.overlay.style.opacity = String(this.fade);
  }

  private newShot(): void {
    const rng = this.rng;
    const subject = this.subjects(rng) ?? this.randomLand();
    const r = Math.max(subject.radius, 5);
    const spinShot = rng() < 0.3;
    const duration = MIN_SHOT + rng() * (MAX_SHOT - MIN_SHOT);
    const dir = rng() < 0.5 ? -1 : 1;
    const burst = !spinShot && rng() < 0.55;
    this.shot = {
      duration,
      yaw: rng() * Math.PI * 2,
      pitch: 0.2 + Math.pow(rng(), 0.8) * 1.05, // from low side-on shots up to nearly top-down
      distance: clamp(r * 2.2 + 28 + rng() * 70, 40, 230),
      // Gentle on purpose (fast camera rotation is nauseating): even a "spin" shot is only ~2.5-4 deg/s.
      spin: spinShot ? dir * (0.045 + rng() * 0.025) : dir * (0.006 + rng() * 0.016),
      burstAt: 1.5 + rng() * Math.max(0.5, duration - 6.5),
      burstLen: burst ? 4 + rng() * 2 : 0,
      burstSpeed: dir * (0.05 + rng() * 0.04),
      pitchDrift: (rng() - 0.5) * 0.012,
      dolly: (rng() - 0.6) * 1.6, // mostly creeping in
      drift: new THREE.Vector2((rng() - 0.5) * 1.6, (rng() - 0.5) * 1.6),
      lift: Math.min(r * 0.35, 14),
      above: Math.max(0, subject.y - Math.max(0, this.heightAt(subject.x, subject.z))) + Math.min(r * 0.35, 14),
    };
    this.t = 0;
    this.spinNow = 0;
    this.yaw = this.shot.yaw;
    this.pitch = this.shot.pitch;
    this.distance = this.shot.distance;
    this.focus.set(subject.x, subject.y, subject.z);
    this.focusY = subject.y + this.shot.lift;
    this.focus.y = this.focusY;
    this.target.copy(this.focus);
    this.fade = 1;
  }

  /** A random dry spot in the play area (fallback subject). */
  private randomLand(): Subject {
    for (let i = 0; i < 30; i++) {
      const x = (this.rng() * 2 - 1) * this.bound * 0.9, z = (this.rng() * 2 - 1) * this.bound * 0.9;
      const y = this.heightAt(x, z);
      if (y > 3) return { x, y, z, radius: 18 };
    }
    return { x: 0, y: this.heightAt(0, 0), z: 0, radius: 18 };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
