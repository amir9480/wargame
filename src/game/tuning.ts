// Central sim/net tuning knobs (see plan: tick rate, snapshot rate, checkpoints).
export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;
/** Transforms are broadcast every N ticks (20 / 2 = 10 Hz). */
export const SNAPSHOT_EVERY = 2;
/** Full-state checkpoint cadence (ticks) used for reconnect / autosave. */
export const CHECKPOINT_EVERY = TICK_RATE * 10;
/** Events kept in the ring buffer for incremental reconnect (ticks of history). */
export const EVENT_HISTORY_TICKS = TICK_RATE * 30;
/** Replica/server state-hash comparison cadence (ticks). */
export const HASH_EVERY = TICK_RATE * 5;
export const MAX_ENTITIES = 1 << 16;
export const MAX_PLAYERS = 4;
