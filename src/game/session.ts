// A running skirmish: the authoritative Simulation + AI opponents + the client replica, connected by a loopback channel
// (so everything the UI sees has been through the binary codecs). Pure TS; the render layer and HUD only touch `client`.
import { sampleGrid } from '../terrain/grid.ts';
import type { Terrain } from '../terrain/pipeline/types.ts';
import { AIPlayer } from './ai/player.ts';
import { BridgeDecks } from './nav/decks.ts';
import { NavGrid } from './nav/navgrid.ts';
import { ClientState } from './net/client.ts';
import { LoopbackChannel } from './net/channel.ts';
import { checkPlacement, type World } from './sim/placement.ts';
import { Simulation } from './sim/simulation.ts';
import type { Command } from './sim/messages.ts';
import { MAX_PLAYERS, TICK_DT } from './tuning.ts';

const MAX_STEPS_PER_FRAME = 6;

/** Gameplay view of a Terrain: heights, the navigation grid, and the "can I build here" test (flat, dry, clear of trees / rocks / buildings / roads). */
export class TerrainWorld implements World {
  private readonly t: Terrain;
  readonly nav: NavGrid;
  private readonly decks: BridgeDecks;

  constructor(t: Terrain, nav?: NavGrid) {
    this.t = t;
    this.nav = nav ?? new NavGrid(t);
    this.decks = new BridgeDecks(t);
  }

  /** Bare ground height (the terrain grid). */
  groundAt(x: number, z: number): number {
    const t = this.t;
    return sampleGrid(t.heights, t.size, (x + t.worldSize / 2) / t.cell, (z + t.worldSize / 2) / t.cell);
  }

  /** Height units stand at: the ground, or the deck on a bridge. */
  heightAt(x: number, z: number): number {
    return this.decks.heightAt(x, z, this.groundAt(x, z));
  }

  buildable(x: number, z: number, radius: number): boolean {
    const t = this.t;
    const half = t.playSize / 2 - radius - 8;
    if (Math.abs(x) > half || Math.abs(z) > half) return false;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = k === 8 ? x : x + Math.cos(a) * radius, pz = k === 8 ? z : z + Math.sin(a) * radius;
      const h = this.groundAt(px, pz);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (lo < 1.2 || hi - lo > 3.2) return false;
    const gi = Math.round((x + t.worldSize / 2) / t.cell), gj = Math.round((z + t.worldSize / 2) / t.cell);
    if (t.mountain[gj * t.size + gi] > 2.5) return false;
    return this.nav.buildableCircle(x, z, radius); // trees, rocks, map buildings and roads
  }
}

export class GameSession {
  readonly sim: Simulation;
  readonly client = new ClientState();
  readonly channel: LoopbackChannel;
  readonly world: TerrainWorld;
  readonly human = 0;
  readonly ais: AIPlayer[] = [];
  paused = false;
  speed = 1;
  private acc = 0;

  constructor(terrain: Terrain, aiLevel: 'easy' | 'normal' | 'hard' = 'normal', nav?: NavGrid) {
    this.world = new TerrainWorld(terrain, nav);
    this.sim = new Simulation(terrain.seed, this.world);
    this.channel = new LoopbackChannel(this.sim, this.client);
    for (let p = 1; p < MAX_PLAYERS; p++) this.ais.push(new AIPlayer(p, aiLevel));

    // Every slot starts with a finished Command Center at its base, a few infantry and two tanks in front of it.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const b = terrain.bases[p];
      const yaw = Math.atan2(-b.x, -b.z); // face the map centre
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      this.sim.submit({ kind: 'placeStructure', player: p, type: 100, x: b.x, z: b.z, yaw, instant: 1 });
      this.sim.submit({ kind: 'spawnUnits', player: p, type: 1, count: 6, x: b.x + fx * 24, z: b.z + fz * 24 });
      this.sim.submit({ kind: 'spawnUnits', player: p, type: 4, count: 2, x: b.x + fx * 34, z: b.z + fz * 34 });
    }
    this.channel.pump();
    this.channel.resync(); // initial sync = the same snapshot path a refresh / late join uses (credits, power, ...)
  }

  /** Advance by `dt` real seconds (fixed ticks, a few per frame at most). */
  update(dt: number): void {
    if (this.paused) return;
    this.acc += Math.min(dt, 0.25) * this.speed;
    for (let n = 0; this.acc >= TICK_DT && n < MAX_STEPS_PER_FRAME; n++) {
      this.acc -= TICK_DT;
      for (const ai of this.ais) ai.think(this.sim);
      this.channel.pump();
    }
    if (this.acc > TICK_DT * MAX_STEPS_PER_FRAME) this.acc = 0; // fell behind: drop the backlog
  }

  /** Seconds of sim time elapsed since the last tick (for render-time extrapolation between ticks). */
  get fraction(): number {
    return this.paused ? 0 : this.acc;
  }

  /** Human command (the player field is forced to the human slot). */
  send(cmd: Command): void {
    this.channel.send({ ...cmd, player: this.human } as Command);
  }

  /** Placement check for the ghost: same rules as the sim, evaluated on the replica. */
  checkPlacement(type: number, x: number, z: number): number {
    return checkPlacement(this.client.store, this.world, this.human, type, x, z, this.client.credits[this.human]);
  }

  get gameOver(): 'won' | 'lost' | null {
    const d = this.client.defeated;
    if (d.includes(this.human)) return 'lost';
    if (d.length >= MAX_PLAYERS - 1) return 'won';
    return null;
  }
}
