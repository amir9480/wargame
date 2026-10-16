// Command (client -> sim) and Event (sim -> clients) schemas. Ids are part of the save/wire format: NEVER renumber.
import { ByteReader, ByteWriter, createRegistry } from '../net/codec.ts';

export interface SpawnUnitsCmd { kind: 'spawnUnits'; player: number; type: number; count: number; x: number; z: number }
export interface MoveCmd { kind: 'move'; player: number; ids: number[]; x: number; z: number }
/** `instant` = 1 places a finished structure for free (game start only; a normal player command is validated and paid). */
export interface PlaceStructureCmd { kind: 'placeStructure'; player: number; type: number; x: number; z: number; yaw: number; instant: number }
export interface SetPowerCmd { kind: 'setPower'; player: number; produced: number; consumed: number }
export interface QueueProductionCmd { kind: 'queueProduction'; player: number; structure: number; unitType: number }
export interface CancelProductionCmd { kind: 'cancelProduction'; player: number; structure: number }
export interface SellCmd { kind: 'sell'; player: number; id: number }
export type Command = SpawnUnitsCmd | MoveCmd | PlaceStructureCmd | SetPowerCmd | QueueProductionCmd | CancelProductionCmd | SellCmd;

export interface EntitySpawnedEv { kind: 'entitySpawned'; tick: number; id: number; type: number; owner: number; x: number; y: number; z: number; yaw: number; progress: number; hp: number }
export interface EntityRemovedEv { kind: 'entityRemoved'; tick: number; id: number }
/** Authoritative synced construction value: progress is u16 (0..65535 = 0..1), advancing at `rate` per second. */
export interface StructureProgressEv { kind: 'structureProgress'; tick: number; id: number; progress: number; rate: number }
export interface StructureCompletedEv { kind: 'structureCompleted'; tick: number; id: number }
export interface PowerChangedEv { kind: 'powerChanged'; tick: number; player: number; factor: number; produced: number; consumed: number }
export interface StateHashEv { kind: 'stateHash'; tick: number; hash: number }
export interface HpChangedEv { kind: 'hpChanged'; tick: number; id: number; hp: number }
export interface CreditsChangedEv { kind: 'creditsChanged'; tick: number; player: number; credits: number }
/** Production at a structure: head-of-queue unit with the same synced 0..1 value; unitType 0 = idle. `queued` = items waiting. */
export interface ProductionProgressEv { kind: 'productionProgress'; tick: number; id: number; unitType: number; progress: number; rate: number; queued: number }
export interface FireEv { kind: 'fire'; tick: number; from: number; to: number }
export interface CommandRejectedEv { kind: 'commandRejected'; tick: number; player: number; reason: number }
export interface PlayerDefeatedEv { kind: 'playerDefeated'; tick: number; player: number }
export type GameEvent = EntitySpawnedEv | EntityRemovedEv | StructureProgressEv | StructureCompletedEv | PowerChangedEv | StateHashEv
  | HpChangedEv | CreditsChangedEv | ProductionProgressEv | FireEv | CommandRejectedEv | PlayerDefeatedEv;

export const REJECT = { none: 0, prerequisite: 1, credits: 2, range: 3, blocked: 4, terrain: 5, invalid: 6, queueFull: 7, noPath: 8 } as const;
export const REJECT_TEXT: Record<number, string> = {
  1: 'Requires another structure first', 2: 'Not enough credits', 3: 'Too far from your base', 4: 'Blocked by another structure',
  5: 'Unsuitable terrain', 6: 'Invalid order', 7: 'Production queue is full', 8: 'No path there',
};

export const commands = createRegistry<Command['kind']>();
commands.define('spawnUnits', 1, [['player', 'u8'], ['type', 'u16'], ['count', 'u16'], ['x', 'f32'], ['z', 'f32']]);
commands.define('move', 2, [['player', 'u8'], ['ids', 'ids'], ['x', 'f32'], ['z', 'f32']]);
commands.define('placeStructure', 3, [['player', 'u8'], ['type', 'u16'], ['x', 'f32'], ['z', 'f32'], ['yaw', 'f32'], ['instant', 'u8']]);
commands.define('setPower', 4, [['player', 'u8'], ['produced', 'f32'], ['consumed', 'f32']]);
commands.define('queueProduction', 5, [['player', 'u8'], ['structure', 'u32'], ['unitType', 'u16']]);
commands.define('cancelProduction', 6, [['player', 'u8'], ['structure', 'u32']]);
commands.define('sell', 7, [['player', 'u8'], ['id', 'u32']]);

export const events = createRegistry<GameEvent['kind']>();
events.define('entitySpawned', 1, [['tick', 'u32'], ['id', 'u32'], ['type', 'u16'], ['owner', 'u8'], ['x', 'f32'], ['y', 'f32'], ['z', 'f32'], ['yaw', 'f32'], ['progress', 'u16'], ['hp', 'u16']]);
events.define('entityRemoved', 2, [['tick', 'u32'], ['id', 'u32']]);
events.define('structureProgress', 3, [['tick', 'u32'], ['id', 'u32'], ['progress', 'u16'], ['rate', 'f32']]);
events.define('structureCompleted', 4, [['tick', 'u32'], ['id', 'u32']]);
events.define('powerChanged', 5, [['tick', 'u32'], ['player', 'u8'], ['factor', 'f32'], ['produced', 'i16'], ['consumed', 'i16']]);
events.define('stateHash', 6, [['tick', 'u32'], ['hash', 'u32']]);
events.define('hpChanged', 7, [['tick', 'u32'], ['id', 'u32'], ['hp', 'u16']]);
events.define('creditsChanged', 8, [['tick', 'u32'], ['player', 'u8'], ['credits', 'u32']]);
events.define('productionProgress', 9, [['tick', 'u32'], ['id', 'u32'], ['unitType', 'u16'], ['progress', 'u16'], ['rate', 'f32'], ['queued', 'u8']]);
events.define('fire', 10, [['tick', 'u32'], ['from', 'u32'], ['to', 'u32']]);
events.define('commandRejected', 11, [['tick', 'u32'], ['player', 'u8'], ['reason', 'u8']]);
events.define('playerDefeated', 12, [['tick', 'u32'], ['player', 'u8']]);

/** Continuous pose stream (differential: only entities whose pose changed since the last snapshot). */
export interface TransformEntry { id: number; x: number; y: number; z: number; yaw: number; vx: number; vz: number; state: number }
export interface TransformBatch { tick: number; entries: TransformEntry[] }

export function encodeTransforms(b: TransformBatch): Uint8Array {
  const w = new ByteWriter();
  w.u32(b.tick);
  w.u32(b.entries.length);
  for (const e of b.entries) { w.u32(e.id); w.f32(e.x); w.f32(e.y); w.f32(e.z); w.f32(e.yaw); w.f32(e.vx); w.f32(e.vz); w.u8(e.state); }
  return w.bytes();
}

export function decodeTransforms(bytes: Uint8Array): TransformBatch {
  const r = new ByteReader(bytes);
  const tick = r.u32();
  const n = r.u32();
  const entries: TransformEntry[] = [];
  for (let i = 0; i < n; i++) entries.push({ id: r.u32(), x: r.f32(), y: r.f32(), z: r.f32(), yaw: r.f32(), vx: r.f32(), vz: r.f32(), state: r.u8() });
  return { tick, entries };
}

export function encodeEvents(list: GameEvent[]): Uint8Array {
  const w = new ByteWriter();
  w.u32(list.length);
  for (const e of list) events.encode(w, e);
  return w.bytes();
}

export function decodeEvents(bytes: Uint8Array): GameEvent[] {
  const r = new ByteReader(bytes);
  const n = r.u32();
  const out: GameEvent[] = [];
  for (let i = 0; i < n; i++) out.push(events.decode(r) as GameEvent);
  return out;
}

export function encodeCommand(c: Command): Uint8Array {
  const w = new ByteWriter();
  commands.encode(w, c);
  return w.bytes();
}

export function decodeCommand(bytes: Uint8Array): Command {
  return commands.decode(new ByteReader(bytes)) as Command;
}
