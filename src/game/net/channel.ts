// Transport between a Simulation host and a ClientState. LoopbackChannel round-trips everything through the binary
// codecs, so single-player and tests exercise exactly the bytes a Worker/WebSocket transport would carry.
import { ClientState } from './client.ts';
import {
  decodeCommand, decodeEvents, decodeTransforms, encodeCommand, encodeEvents, encodeTransforms,
  type Command,
} from '../sim/messages.ts';
import type { Simulation, TickOutput } from '../sim/simulation.ts';

export class LoopbackChannel {
  bytesDown = 0;
  private sim: Simulation;
  readonly client: ClientState;

  constructor(sim: Simulation, client: ClientState) {
    this.sim = sim;
    this.client = client;
  }

  /** Client -> sim. */
  send(cmd: Command): void {
    this.sim.submit(decodeCommand(encodeCommand(cmd)));
  }

  /** Sim -> client (call with each TickOutput). */
  deliver(out: TickOutput): void {
    const ev = encodeEvents(out.events);
    this.bytesDown += ev.length;
    this.client.applyEvents(decodeEvents(ev));
    if (out.transforms) {
      const tr = encodeTransforms(out.transforms);
      this.bytesDown += tr.length;
      this.client.applyTransforms(decodeTransforms(tr));
    }
    this.client.tick = out.tick;
    this.client.verifyHashes();
  }

  /** Step the sim one tick and deliver it. */
  pump(): TickOutput {
    const out = this.sim.step();
    this.deliver(out);
    return out;
  }

  /** Reconnect: send the client a full snapshot (the catch-up path for refresh / late join). */
  resync(): void {
    this.client.restore(this.sim.snapshot().bytes);
  }
}
