import * as THREE from 'three';

type Action = 'forward' | 'back' | 'left' | 'right' | 'rotateLeft' | 'rotateRight';

const KEYMAP: Record<string, Action> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyQ: 'rotateLeft',
  KeyE: 'rotateRight',
};

export interface CameraView {
  /** Focus point on the ground (world x / z). */
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  distance: number;
}

export interface RTSCameraOptions {
  heightAt: (x: number, z: number) => number;
  /** Half extent of the map; camera focus is clamped to [-bound, bound]. */
  bound: number;
}

/**
 * Strategy-game camera: orbits a focus point on the ground.
 * - Edge scrolling when the cursor is near the window border
 * - WASD / arrow keys pan (Shift = faster), Q/E rotate (yaw), Shift+Q/E tilt (pitch)
 * - Middle mouse drag rotates (yaw) and tilts (pitch)
 * - Mouse wheel zooms
 */
export class RTSCameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  yaw = 0;
  pitch = 0.95;
  distance = 440;

  bound: number;
  heightAt: (x: number, z: number) => number;

  minDistance = 25;
  maxDistance = 1400;
  minPitch = 0.3;
  maxPitch = 1.5;
  edgeMargin = 24;
  /** Pan speed as a fraction of current zoom distance per second. */
  panSpeed = 1.0;
  rotateSpeed = 1.8;

  private dom: HTMLElement;
  private targetDistance = this.distance;
  private focusY = 0;
  private keys = new Set<Action>();
  private shift = false;
  private rotating = false;
  private mouse = { x: 0, y: 0, inside: false, overCanvas: false };
  private ac = new AbortController();
  private on = true;

  /** False while a menu is up (start / pause / game over): keys, edge-pan, rotate and zoom are ignored and held input is released. */
  get enabled(): boolean {
    return this.on;
  }
  set enabled(v: boolean) {
    this.on = v;
    if (!v) {
      this.keys.clear();
      this.rotating = false;
    }
  }

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, opts: RTSCameraOptions) {
    this.camera = camera;
    this.dom = dom;
    this.heightAt = opts.heightAt;
    this.bound = opts.bound;
    this.attach();
  }

  dispose(): void {
    this.ac.abort();
  }

  reset(): void {
    this.target.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0.95;
    this.distance = this.targetDistance = 45;
    this.snapFocus();
  }

  /** Current view (focus on the ground, rotation, zoom), e.g. to persist it. */
  get view(): CameraView {
    return { x: this.target.x, z: this.target.z, yaw: this.yaw, pitch: this.pitch, distance: this.targetDistance };
  }

  /** Jumps to a view; values are clamped to the camera limits. */
  set view(v: CameraView) {
    this.target.x = clamp(v.x, -this.bound, this.bound);
    this.target.z = clamp(v.z, -this.bound, this.bound);
    this.yaw = v.yaw;
    this.pitch = clamp(v.pitch, this.minPitch, this.maxPitch);
    this.distance = this.targetDistance = clamp(v.distance, this.minDistance, this.maxDistance);
    this.snapFocus();
  }

  /** Puts the focus straight onto the ground under it (no easing), e.g. after the terrain changed. */
  snapFocus(): void {
    this.focusY = Math.max(0, this.heightAt(this.target.x, this.target.z));
  }

  private attach(): void {
    const signal = this.ac.signal;
    const dom = this.dom;

    window.addEventListener('keydown', (e) => {
      if (!this.on || isTyping(e.target)) return;
      this.shift = e.shiftKey;
      const action = KEYMAP[e.code];
      if (action) {
        this.keys.add(action);
        e.preventDefault();
      }
    }, { signal });

    window.addEventListener('keyup', (e) => {
      this.shift = e.shiftKey;
      const action = KEYMAP[e.code];
      if (action) this.keys.delete(action);
    }, { signal });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.rotating = false;
      this.mouse.inside = false;
    }, { signal });

    window.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.inside = true;
      this.mouse.overCanvas = e.target === dom;
      if (this.rotating && this.on) {
        this.yaw -= e.movementX * 0.005;
        this.pitch = clamp(this.pitch + e.movementY * 0.004, this.minPitch, this.maxPitch);
      }
    }, { signal });

    document.documentElement.addEventListener('mouseleave', () => {
      this.mouse.inside = false;
    }, { signal });

    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 || !this.on) return;
      e.preventDefault(); // stop browser middle-click autoscroll
      this.rotating = true;
      dom.setPointerCapture(e.pointerId);
    }, { signal });

    dom.addEventListener('pointerup', (e) => {
      if (e.button !== 1) return;
      this.rotating = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    }, { signal });

    dom.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    }, { signal });

    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.on) return;
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      this.targetDistance = clamp(this.targetDistance * Math.exp(delta * 0.0012), this.minDistance, this.maxDistance);
    }, { signal, passive: false });

    dom.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  }

  update(dt: number): void {
    let mx = 0, mz = 0;
    if (this.keys.has('forward')) mz += 1;
    if (this.keys.has('back')) mz -= 1;
    if (this.keys.has('left')) mx -= 1;
    if (this.keys.has('right')) mx += 1;

    if (this.on && this.mouse.inside && this.mouse.overCanvas && !this.rotating) {
      const m = this.edgeMargin;
      if (this.mouse.x < m) mx -= 1;
      if (this.mouse.x > window.innerWidth - m) mx += 1;
      if (this.mouse.y < m) mz += 1;
      if (this.mouse.y > window.innerHeight - m) mz -= 1;
    }

    const rot = (this.keys.has('rotateLeft') ? 1 : 0) - (this.keys.has('rotateRight') ? 1 : 0);
    if (rot !== 0) {
      if (this.shift) this.pitch = clamp(this.pitch - rot * this.rotateSpeed * dt, this.minPitch, this.maxPitch);
      else this.yaw += rot * this.rotateSpeed * dt;
    }

    if (mx !== 0 || mz !== 0) {
      const len = Math.hypot(mx, mz);
      const speed = this.distance * this.panSpeed * dt * (this.shift ? 2.5 : 1);
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      // forward on ground = (-sin, -cos), right = (cos, -sin)
      this.target.x += ((cos * mx - sin * mz) / len) * speed;
      this.target.z += ((-sin * mx - cos * mz) / len) * speed;
    }
    this.target.x = clamp(this.target.x, -this.bound, this.bound);
    this.target.z = clamp(this.target.z, -this.bound, this.bound);

    const smooth = 1 - Math.exp(-10 * dt);
    this.distance += (this.targetDistance - this.distance) * smooth;
    const ground = Math.max(0, this.heightAt(this.target.x, this.target.z));
    this.focusY += (ground - this.focusY) * (1 - Math.exp(-4 * dt));
    this.target.y = this.focusY;

    const cp = Math.cos(this.pitch);
    const pos = this.camera.position;
    pos.set(
      this.target.x + this.distance * cp * Math.sin(this.yaw),
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + this.distance * cp * Math.cos(this.yaw),
    );
    const minY = Math.max(0, this.heightAt(pos.x, pos.z)) + 4;
    if (pos.y < minY) pos.y = minY;
    this.camera.lookAt(this.target);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isTyping(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}
