// Sim health checks: determinism, save/load equivalence, replica == sim (reconnect property), synced progress, Jolt.
// Run: node scripts/sim-check.ts
import { ClientState } from '../src/game/net/client.ts';
import { LoopbackChannel } from '../src/game/net/channel.ts';
import { Simulation } from '../src/game/sim/simulation.ts';
import type { Command } from '../src/game/sim/messages.ts';
import { entityIndex } from '../src/game/store/entities.ts';
import { TICK_RATE } from '../src/game/tuning.ts';
import { loadJolt, PhysicsWorld } from '../src/game/physics/jolt.ts';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
}

const script = (tick: number, sim: Simulation): void => {
  const cmds: Command[] = [];
  if (tick === 1) cmds.push({ kind: 'spawnUnits', player: 0, type: 1, count: 100, x: 0, z: 0 });
  if (tick === 1) cmds.push({ kind: 'spawnUnits', player: 1, type: 4, count: 10, x: 100, z: 100 });
  if (tick === 5) {
    const ids: number[] = [];
    for (let i = 0; i < sim.store.highWater; i++) if (sim.store.alive[i] && sim.store.owner[i] === 0) ids.push(sim.store.idAt(i));
    cmds.push({ kind: 'move', player: 0, ids, x: 300, z: -200 });
  }
  if (tick === 1) cmds.push({ kind: 'placeStructure', player: 0, type: 100, x: 0, z: 0, yaw: 0, instant: 1 });
  if (tick === 10) cmds.push({ kind: 'placeStructure', player: 0, type: 101, x: 40, z: 0, yaw: 0, instant: 0 });
  if (tick === 100) cmds.push({ kind: 'setPower', player: 0, produced: 5, consumed: 20 });
  if (tick === 300) cmds.push({ kind: 'spawnUnits', player: 0, type: 1, count: 20, x: -50, z: 0 });
  for (const c of cmds) sim.submit(c);
};

function run(sim: Simulation, from: number, to: number, ch?: LoopbackChannel): void {
  for (let t = from; t < to; t++) {
    script(sim.tick + 1, sim);
    if (ch) ch.pump(); else sim.step();
  }
}

// 1. Determinism: same seed + same command script => same hash.
const a = new Simulation(1234), b = new Simulation(1234);
run(a, 0, 600); run(b, 0, 600);
check('determinism (same seed/commands => same hash)', a.store.hash() === b.store.hash(), `hash=${a.store.hash()}`);
const c = new Simulation(999); run(c, 0, 600);
check('different seed => different hash', c.store.hash() !== a.store.hash());

// 2. Replica == sim through the binary codecs (also exercises the in-stream desync detector).
const sim = new Simulation(1234);
const replica = new ClientState();
const ch = new LoopbackChannel(sim, replica);
run(sim, 0, 600, ch);
check('replica hash == sim hash', replica.store.hash() === sim.store.hash());
check('no desync detected by stateHash events', replica.desyncAt < 0);
console.log(`      downstream: ${(ch.bytesDown / 1024).toFixed(1)} KiB over 600 ticks (${(ch.bytesDown / 30 / 1024).toFixed(2)} KiB/s)`);

// 3. Save/load: snapshot at T, restore, continue => identical to uninterrupted run (including new entity ids).
const full = new Simulation(77); run(full, 0, 400);
const half = new Simulation(77); run(half, 0, 200);
const snap = half.snapshot();
const loaded = Simulation.fromSnapshot(snap.bytes);
run(loaded, 200, 400);
check('save/load equivalence', loaded.store.hash() === full.store.hash() && loaded.tick === full.tick);

// 4. Reconnect: client joins mid-construction via snapshot + continues from events; synced progress agrees.
const live = new Simulation(5); const liveClient = new ClientState();
const liveCh = new LoopbackChannel(live, liveClient);
run(live, 0, 130, liveCh);
const late = new ClientState();
late.restore(live.snapshot().bytes);
const lateCh = new LoopbackChannel(live, late);
for (let t = 0; t < 220; t++) { script(live.tick + 1, live); const out = live.step(); liveCh.deliver(out); lateCh.deliver(out); }
let structure = -1;
for (let i = 0; i < live.store.highWater; i++) if (live.store.alive[i] && live.store.type[i] === 101) structure = i;
const tNow = live.tick;
const pLive = live.store.progressAt(structure, tNow);
check('structure exists and progresses', structure >= 0 && pLive > 0, `progress=${pLive.toFixed(3)}`);
check('late joiner progress == live progress', Math.abs(late.store.progressAt(structure, tNow) - pLive) < 1e-6 && late.store.hash() === live.store.hash());
check('power cut slowed construction (rate)', live.store.pRate[structure] === 0 || live.store.pRate[structure] <= 0.25 / 20 + 1e-9);

// 5. Soak: 4 players, 600 units.
const soak = new Simulation(1);
for (let p = 0; p < 4; p++) soak.submit({ kind: 'spawnUnits', player: p, type: 1, count: 150, x: p * 200, z: 0 });
soak.step();
const ids: number[] = [];
for (let i = 0; i < soak.store.highWater; i++) ids.push(soak.store.idAt(i));
for (let p = 0; p < 4; p++) soak.submit({ kind: 'move', player: p, ids: ids.filter((id) => soak.store.owner[entityIndex(id)] === p), x: 400, z: 400 });
const t0 = performance.now();
for (let t = 0; t < TICK_RATE * 60; t++) soak.step();
const ms = (performance.now() - t0) / (TICK_RATE * 60);
let finite = true;
for (let i = 0; i < soak.store.highWater; i++) if (!Number.isFinite(soak.store.x[i]) || !Number.isFinite(soak.store.z[i])) finite = false;
check('soak: 600 units x 60 s all finite', finite, `${ms.toFixed(3)} ms/tick`);

// 5b. Skirmish: 4 AIs on a flat map for 8 minutes: they build, produce, fight; replica stays in sync.
{
  const { AIPlayer } = await import('../src/game/ai/player.ts');
  const sk = new Simulation(4242);
  const skClient = new ClientState();
  const skCh = new LoopbackChannel(sk, skClient);
  const corners = [[-300, -300], [300, -300], [300, 300], [-300, 300]];
  corners.forEach(([x, z], p) => {
    sk.submit({ kind: 'placeStructure', player: p, type: 100, x, z, yaw: 0, instant: 1 });
    sk.submit({ kind: 'spawnUnits', player: p, type: 1, count: 6, x: x * 0.8, z: z * 0.8 });
  });
  const ais = [0, 1, 2, 3].map((p) => new AIPlayer(p, 'hard'));
  const t1 = performance.now();
  for (let t = 0; t < TICK_RATE * 60 * 8; t++) { for (const ai of ais) ai.think(sk); skCh.pump(); }
  const msPerTick = (performance.now() - t1) / (TICK_RATE * 60 * 8);
  let structures = 0, units = 0;
  for (let i = 0; i < sk.store.highWater; i++) if (sk.store.alive[i]) { if (sk.store.type[i] >= 100) structures++; else units++; }
  check('skirmish: AIs built structures and units', structures > 8 && units > 6, `structures=${structures} units=${units} defeated=${sk.defeated.length} credits=${sk.credits.map(Math.floor)}`);
  check('skirmish: replica hash == sim hash', skClient.store.hash() === sk.store.hash() && skClient.desyncAt < 0, `${msPerTick.toFixed(3)} ms/tick`);
}

// 5c. Pathfinding on a real generated map: A* routes avoid obstacles, prefer roads, and AI units never walk through them.
{
  const { generateTerrain } = await import('../src/terrain/generate.ts');
  const { loadMountainLibrary } = await import('../src/terrain/mountains/node.ts');
  const { MAP_CELL } = await import('../src/terrain/scale.ts');
  const { GameSession } = await import('../src/game/session.ts');
  const { UNIT_BY_ID } = await import('../src/game/defs/units.ts');
  const terrain = generateTerrain(42, await loadMountainLibrary(), { size: 640, cell: MAP_CELL });
  const game = new GameSession(terrain, 'hard');
  const nav = game.world.nav;
  let ok = 0, blockedSamples = 0, roadSamples = 0, samples = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    if (a === b) continue;
    const path = nav.findPath('tracked', terrain.bases[a].x, terrain.bases[a].z, terrain.bases[b].x, terrain.bases[b].z);
    if (!path) continue;
    ok++;
    let px = terrain.bases[a].x, pz = terrain.bases[a].z;
    for (let k = 0; k < path.length; k += 2) {
      const d = Math.hypot(path[k] - px, path[k + 1] - pz), steps = Math.max(1, Math.ceil(d));
      for (let st = 1; st <= steps; st++) {
        const i = nav.idx(nav.cellOf(px + ((path[k] - px) * st) / steps), nav.cellOf(pz + ((path[k + 1] - pz) * st) / steps));
        samples++; if (nav.road[i]) roadSamples++;
        // routes start / end at base centres, inside the Command Center's footprint: ignore the first and last 16 m
        const px2 = px + ((path[k] - px) * st) / steps, pz2 = pz + ((path[k + 1] - pz) * st) / steps;
        const nearEnd = Math.hypot(px2 - terrain.bases[a].x, pz2 - terrain.bases[a].z) < 16 || Math.hypot(px2 - terrain.bases[b].x, pz2 - terrain.bases[b].z) < 16;
        if (!nearEnd && !nav.passable('tracked', i)) blockedSamples++;
      }
      px = path[k]; pz = path[k + 1];
    }
  }
  check('A*: every base reaches every other base (tracked)', ok === 12, `${ok}/12`);
  check('A*: routes never cross blocked cells and mostly use roads', blockedSamples === 0 && roadSamples / samples > 0.5, `blocked=${blockedSamples} road share=${Math.round((100 * roadSamples) / samples)}%`);
  const s2 = game.sim.store;
  let moving = 0, onBlocked = 0;
  for (let tick = 0; tick < TICK_RATE * 60 * 4; tick++) {
    game.update(1 / TICK_RATE);
    if (tick % 10) continue;
    for (let i = 0; i < s2.highWater; i++) {
      if (!s2.alive[i] || s2.type[i] >= 100 || s2.state[i] !== 1) continue;
      const ci = nav.idx(nav.cellOf(s2.x[i]), nav.cellOf(s2.z[i]));
      moving++;
      if (!nav.passable(UNIT_BY_ID.get(s2.type[i])!.mover, ci) && !nav.road[ci]) onBlocked++;
    }
  }
  check('AI units stay off trees / rocks / buildings / water (4 min skirmish)', moving > 1000 && onBlocked / moving < 0.005, `${onBlocked}/${moving} samples on blocked cells`);
  // units keep apart from each other and from structures (end state of the skirmish)
  const { STRUCTURE_BY_ID } = await import('../src/game/defs/structures.ts');
  const { UNIT_SCALE } = await import('../src/game/defs/units.ts');
  let pairs = 0, overlapping = 0, inside = 0, unitCount = 0;
  for (let i = 0; i < s2.highWater; i++) {
    if (!s2.alive[i] || s2.type[i] >= 100) continue;
    unitCount++;
    const ri = UNIT_BY_ID.get(s2.type[i])!.radius * UNIT_SCALE;
    for (let j = i + 1; j < s2.highWater; j++) {
      if (!s2.alive[j] || s2.type[j] >= 100) continue;
      pairs++;
      if (Math.hypot(s2.x[i] - s2.x[j], s2.z[i] - s2.z[j]) < (ri + UNIT_BY_ID.get(s2.type[j])!.radius * UNIT_SCALE) * 0.6) overlapping++;
    }
    for (let j = 0; j < s2.highWater; j++) {
      if (!s2.alive[j] || s2.type[j] < 100) continue;
      const d = STRUCTURE_BY_ID.get(s2.type[j])!;
      const dx = s2.x[i] - s2.x[j], dz = s2.z[i] - s2.z[j], sn = Math.sin(s2.yaw[j]), cs = Math.cos(s2.yaw[j]);
      if (Math.abs(dx * cs - dz * sn) < d.width / 2 - 0.5 && Math.abs(dx * sn + dz * cs) < d.depth / 2 - 0.5) inside++;
    }
  }
  check('units do not overlap each other or structures', overlapping === 0 && inside === 0, `${unitCount} units, ${overlapping} overlapping pairs, ${inside} inside a structure`);
  // bridge decks: standing height on a bridge is the deck, above the river bed
  let spans = 0, lowSpans = 0;
  for (const e of terrain.roads.edges) {
    if (e.type === 'rail') continue;
    for (const br of e.bridges) {
      spans++;
      const m = e.points[Math.floor((br.start + br.end) / 2)];
      if (game.world.heightAt(m.x, m.z) < m.y - 0.3) lowSpans++;
    }
  }
  check('units stand on bridge decks', spans > 0 && lowSpans === 0, `${spans} spans, ${lowSpans} below the deck`);
  const snap = game.sim.snapshot().bytes;
  const copy = (await import('../src/game/sim/simulation.ts')).Simulation.fromSnapshot(snap, game.world);
  check('paths survive save/load', copy.paths.size === game.sim.paths.size && copy.store.hash() === game.sim.store.hash(), `${copy.paths.size} routes`);
}

// 5d. Combat: a moving group stops for enemies in range, resumes its order afterwards, and the killer is paid a bounty.
{
  const f = new Simulation(31);
  f.submit({ kind: 'spawnUnits', player: 0, type: 4, count: 4, x: 0, z: 0 });
  f.submit({ kind: 'spawnUnits', player: 1, type: 1, count: 3, x: 150, z: 10 });
  f.step();
  const tanks: number[] = [];
  for (let i = 0; i < f.store.highWater; i++) if (f.store.alive[i] && f.store.owner[i] === 0) tanks.push(f.store.idAt(i));
  const credits0 = f.credits[0];
  f.submit({ kind: 'move', player: 0, ids: tanks, x: 320, z: 0 });
  let stoppedNearEnemy = false, resumed = false, enemiesLeft = 3;
  for (let t = 0; t < TICK_RATE * 60; t++) {
    f.step();
    const i = entityIndex(tanks[0]);
    const eng = f.store.engaged[i] === 1 && f.store.state[i] === 1;
    if (eng && f.store.vx[i] === 0 && f.store.vz[i] === 0 && f.store.x[i] < 150) stoppedNearEnemy = true;
    enemiesLeft = 0;
    for (let k = 0; k < f.store.highWater; k++) if (f.store.alive[k] && f.store.owner[k] === 1) enemiesLeft++;
    if (stoppedNearEnemy && enemiesLeft === 0 && f.store.x[i] > 120 && f.store.vx[i] > 0) resumed = true;
  }
  const lead = entityIndex(tanks[0]);
  check('combat: moving tanks stop and fight enemies in range', stoppedNearEnemy);
  check('combat: enemies destroyed, order resumed afterwards', enemiesLeft === 0 && (resumed || f.store.x[lead] > 300), `x=${f.store.x[lead].toFixed(0)}`);
  check('combat: kills pay a bounty', f.credits[0] >= credits0 + 3 * 100 * 0.4 - 1, `+${Math.round(f.credits[0] - credits0)}`);
}

// 6. Jolt: heightfield + raycast.
const J = await loadJolt();
const pw = new PhysicsWorld(J);
const n = 64, h = new Float32Array(n * n).fill(5);
pw.addHeightField(h, n, 2, -64, -64);
const frac = pw.castRay(0, 105, 0, 0, -200, 0);
check('jolt heightfield raycast hits y=5', Math.abs(frac - 0.5) < 1e-3, `fraction=${frac}`);
pw.dispose();

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
