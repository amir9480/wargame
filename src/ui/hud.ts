// Game HUD (Alpine component `gameHud`). Separate from the debug panel (`mapPanel`): it only talks to the GameController,
// polling a small plain state object ~10x/s. The minimap is a plain canvas redrawn on the same tick.
import Alpine from 'alpinejs';
import type { Engine } from '../engine.ts';
import type { GameController, HudState } from './gameController.ts';

export function registerHud(engine: Engine | null, game: GameController | null): void {
  Alpine.data('gameHud', () => ({
    s: { active: false } as HudState,
    ready: false,
    /** Seed of the current map (start menu). */
    seed: null as number | null,
    level: 'normal' as 'easy' | 'normal' | 'hard',
    /** Start menu mode selector: a skirmish, or the view-only debug mode. */
    mode: 'game' as 'game' | 'debug',
    wasDebug: false,
    debug: false,
    timer: 0,

    init() {
      this.timer = window.setInterval(() => this.poll(), 100);
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F2') { e.preventDefault(); this.toggleDebug(); }
      });
    },

    poll() {
      if (!game || !engine) return;
      this.ready = !!engine.terrain;
      this.seed = engine.terrain?.seed ?? null;
      this.s = game.hudState();
      if (this.s.debugMode) this.mode = 'debug';
      else if (this.wasDebug) this.mode = 'game'; // back from debug mode: the menu opens on "Game"
      this.wasDebug = this.s.debugMode;
      // Looked up directly: `$refs` is not reliable from a timer callback / inside x-if.
      const mm = document.querySelector<HTMLCanvasElement>('#hud .minimap canvas');
      if (mm && this.s.active) game.drawMinimap(mm);
    },

    start() {
      if (this.mode === 'debug') game?.setDebugMode(true);
      else if (game?.start(this.level)) this.poll();
    },

    /** Start menu: generate a new map with a random seed (handled by the map generator panel's generate path). */
    newWorld() {
      if (this.ready) window.dispatchEvent(new CustomEvent('wargame:new-world'));
    },

    quit() {
      game?.stop();
      this.poll();
    },

    toggleDebug() {
      this.debug = !this.debug;
      document.body.classList.toggle('show-debug', this.debug);
    },

    build(id: number) { game?.beginPlacing(id); },
    unit(structure: number, unit: number) { game?.queueUnit(structure, unit); },
    cancelQueue(structure: number) { game?.cancelQueue(structure); },
    sell() { game?.sellSelected(); },
    home() { game?.focusBase(); },
    pause() { game?.togglePause(); },
    speed(v: number) { game?.setSpeed(v); },

    minimap(e: MouseEvent) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      game?.minimapClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    },

    get powerPct(): number {
      const p = this.s.power;
      if (!p || p.produced <= 0) return p && p.consumed > 0 ? 0 : 100;
      return Math.min(100, Math.round((p.produced / Math.max(1, p.consumed)) * 100));
    },
  }));
}
