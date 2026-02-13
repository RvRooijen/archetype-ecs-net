// Interest management multi-client benchmark
// Run with: npx tsx bench/interest-bench.ts

import { createEntityManager, component } from 'archetype-ecs';
import type { EntityId } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import type { Changeset } from '../src/DirtyTracker.js';
import { createClientView } from '../src/InterestManager.js';
import type { ClientDelta } from '../src/InterestManager.js';
import { ProtocolEncoder } from '../src/Protocol.js';

const Position = component('BPos', { x: 'f32', y: 'f32', z: 'f32' });
const Velocity = component('BVel', { vx: 'f32', vy: 'f32', vz: 'f32' });
const Health   = component('BHp',  { hp: 'i32', maxHp: 'i32', armor: 'i32' });
const Combat   = component('BCombat', { damage: 'f32', range: 'f32', cooldown: 'f32', timer: 'f32' });
const AI       = component('BAI',  { state: 'u8', target: 'u16', aggro: 'f32', patrol: 'f32' });

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Velocity, name: 'Velocity' },
  { component: Health,   name: 'Health' },
  { component: Combat,   name: 'Combat' },
  { component: AI,       name: 'AI' },
]);

function gameTick(em: ReturnType<typeof createEntityManager>) {
  em.forEach([Position, Velocity], (a) => {
    const px = a.field(Position.x) as Float32Array;
    const py = a.field(Position.y) as Float32Array;
    const pz = a.field(Position.z) as Float32Array;
    const vx = a.field(Velocity.vx) as Float32Array;
    const vy = a.field(Velocity.vy) as Float32Array;
    const vz = a.field(Velocity.vz) as Float32Array;
    for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i]; pz[i] += vz[i]; }
  });
  em.forEach([Combat], (a) => {
    const timer = a.field(Combat.timer) as Float32Array;
    const cd = a.field(Combat.cooldown) as Float32Array;
    for (let i = 0; i < a.count; i++) {
      timer[i] += 0.016;
      if (timer[i] >= cd[i]) timer[i] = 0;
    }
  });
  em.forEach([AI, Position], (a) => {
    const aggro = a.field(AI.aggro) as Float32Array;
    const patrol = a.field(AI.patrol) as Float32Array;
    const px = a.field(Position.x) as Float32Array;
    const pz = a.field(Position.z) as Float32Array;
    for (let i = 0; i < a.count; i++) {
      aggro[i] *= 0.99;
      if (aggro[i] < 0.01) {
        px[i] += Math.sin(patrol[i]) * 0.1;
        pz[i] += Math.cos(patrol[i]) * 0.1;
        patrol[i] += 0.05;
      }
    }
  });
}

const EMPTY_KEY = '||||';

function deltaKey(d: ClientDelta): string {
  if (d.enters.length === 0 && d.leaves.length === 0 && d.updates.length === 0 && d.attached.length === 0 && d.detached.length === 0) return EMPTY_KEY;
  const e = d.enters.length > 1 ? d.enters.slice().sort((a, b) => a - b) : d.enters;
  const l = d.leaves.length > 1 ? d.leaves.slice().sort((a, b) => a - b) : d.leaves;
  const u = d.updates.length > 1 ? d.updates.slice().sort((a, b) => a - b) : d.updates;
  const at = d.attached.length > 1 ? d.attached.slice().sort((a, b) => a - b) : d.attached;
  const dt = d.detached.length > 1 ? d.detached.slice().sort((a, b) => a - b) : d.detached;
  return `${e.join(',')}|${l.join(',')}|${u.join(',')}|${at.join(',')}|${dt.join(',')}`;
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

const PLAYERS = 5000;
const NPCS = 2000;
const MOBS = 1000;
const CLIENT_COUNTS = [100, 500, 1000, 2000, 5000];

function runScenario(
  label: string,
  makeInterest: (allNetIds: Set<number>, playerNetIds: number[], clientIndex: number) => Set<number>,
  mutatePerPlayer?: (em: ReturnType<typeof createEntityManager>, playerEntities: EntityId[], frame: number) => void,
) {
  console.log(`  ${label}`);

  for (const CLIENT_COUNT of CLIENT_COUNTS) {
    const em = createEntityManager();

    const playerEntities: EntityId[] = [];
    for (let i = 0; i < PLAYERS; i++) {
      playerEntities.push(em.createEntityWith(
        Position, { x: Math.random() * 200, y: 0, z: Math.random() * 200 },
        Velocity, { vx: (Math.random() - 0.5) * 2, vy: 0, vz: (Math.random() - 0.5) * 2 },
        Health, { hp: 99, maxHp: 99, armor: 0 },
        Combat, { damage: 10, range: 1, cooldown: 2.4, timer: 0 },
        Networked,
      ));
    }
    for (let i = 0; i < NPCS; i++) {
      em.createEntityWith(
        Position, { x: Math.random() * 200, y: 0, z: Math.random() * 200 },
        Velocity, { vx: (Math.random() - 0.5), vy: 0, vz: (Math.random() - 0.5) },
        Health, { hp: 50, maxHp: 50, armor: 5 },
        Combat, { damage: 5, range: 1, cooldown: 3, timer: 0 },
        AI, { state: 1, target: 0, aggro: 0, patrol: 10 },
        Networked,
      );
    }
    for (let i = 0; i < MOBS; i++) {
      em.createEntityWith(
        Position, { x: Math.random() * 200, y: 0, z: Math.random() * 200 },
        Velocity, { vx: (Math.random() - 0.5) * 0.3, vy: 0, vz: (Math.random() - 0.5) * 0.3 },
        Health, { hp: 200, maxHp: 200, armor: 20 },
        Combat, { damage: 15, range: 2, cooldown: 3, timer: 0 },
        AI, { state: 0, target: 0, aggro: 0, patrol: 20 },
        Networked,
      );
    }

    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();

    differ.computeChangeset();
    differ.flushSnapshots();

    const allNetIds = new Set(differ.entityNetIds.values());
    const playerNetIds = playerEntities.map(eid => differ.entityNetIds.get(eid)!);

    const views = Array.from({ length: CLIENT_COUNT }, () => {
      const v = createClientView();
      v.initKnown(allNetIds);
      return v;
    });

    // Build interest sets per client
    const interests = Array.from({ length: CLIENT_COUNT }, (_, i) =>
      makeInterest(allNetIds, playerNetIds, i));

    const frames = CLIENT_COUNT >= 2000 ? 3 : CLIENT_COUNT >= 500 ? 8 : 15;
    let diffTotal = 0;
    let preEncTotal = 0;
    let composeTotal = 0;
    let totalBytes = 0;
    let uniqueGroups = 0;

    for (let f = 0; f < frames; f++) {
      gameTick(em);
      if (mutatePerPlayer) mutatePerPlayer(em, playerEntities, f);

      const t1 = performance.now();
      const changeset = differ.computeChangeset();
      const t2 = performance.now();
      diffTotal += t2 - t1;

      // Phase 1: compute deltas + group + collect extra enters
      const groups = new Map<string, { delta: ClientDelta; count: number }>();
      const extraEnterNetIds = new Set<number>();

      for (let c = 0; c < CLIENT_COUNT; c++) {
        const delta = views[c].update(interests[c], changeset);
        const key = deltaKey(delta);
        if (key === EMPTY_KEY) continue;

        let group = groups.get(key);
        if (!group) {
          group = {
            delta: { enters: [...delta.enters], leaves: [...delta.leaves], updates: [...delta.updates], attached: [...delta.attached], detached: [...delta.detached] },
            count: 0,
          };
          groups.set(key, group);
        }
        group.count++;

        for (const netId of delta.enters) {
          if (!changeset.createdSet.has(netId)) extraEnterNetIds.add(netId);
        }
      }

      // Phase 2: pre-encode
      const t3 = performance.now();
      const cache = differ.preEncodeChangeset(encoder, changeset, extraEnterNetIds);
      preEncTotal += performance.now() - t3;

      // Phase 3: compose from cache
      const t4 = performance.now();
      for (const group of groups.values()) {
        const buf = differ.composeFromCache(encoder, cache, group.delta);
        if (f === frames - 1) {
          totalBytes += buf.byteLength * group.count;
          uniqueGroups = groups.size;
        }
      }
      composeTotal += performance.now() - t4;

      differ.flushSnapshots();
    }

    const diffMs = diffTotal / frames;
    const preEncMs = preEncTotal / frames;
    const composeMs = composeTotal / frames;
    const totalMs = diffMs + preEncMs + composeMs;
    const bytesPerClient = totalBytes / CLIENT_COUNT;

    process.stdout.write(`    ${pad(CLIENT_COUNT + 'c', 6)}`);
    process.stdout.write(`  diff ${pad(diffMs.toFixed(1) + 'ms', 7)}`);
    process.stdout.write(`  pre-enc ${pad(preEncMs.toFixed(1) + 'ms', 7)}`);
    process.stdout.write(`  compose ${pad(composeMs.toFixed(1) + 'ms', 8)}`);
    process.stdout.write(`  groups ${pad(String(uniqueGroups), 5)}`);
    process.stdout.write(`  total ${pad(totalMs.toFixed(1) + 'ms', 8)}`);
    process.stdout.write(`  wire ${pad((bytesPerClient / 1024).toFixed(1) + ' KB/c', 10)}`);
    console.log();
  }
  console.log();
}

console.log(`\n=== Interest Management Benchmark: ${PLAYERS} players + ${NPCS} NPCs + ${MOBS} mobs (${PLAYERS + NPCS + MOBS} total) ===\n`);

// Scenario 1: everyone sees everything (identical deltas → 1 group)
runScenario(
  'Everyone sees everything (identical deltas → 1 group)',
  (allNetIds) => allNetIds,
);

// Scenario 2: everyone sees everything + unique HP per player
runScenario(
  'Everyone sees everything + unique HP per player',
  (allNetIds) => allNetIds,
  (em, playerEntities, frame) => {
    for (let i = 0; i < playerEntities.length; i++) {
      em.set(playerEntities[i], Health.hp, 50 + (frame * 7 + i) % 49);
    }
  },
);

// Scenario 3: 50% visibility (each client sees random half of entities)
runScenario(
  '50% visibility (each client sees random half)',
  (allNetIds, _playerNetIds, clientIndex) => {
    const half = new Set<number>();
    const arr = [...allNetIds];
    // Deterministic split based on clientIndex
    for (let i = 0; i < arr.length; i++) {
      if ((arr[i] + clientIndex) % 2 === 0) half.add(arr[i]);
    }
    return half;
  },
);

// Scenario 4: 10% visibility (small view radius — each client sees ~10% of entities)
runScenario(
  '10% visibility (small view radius)',
  (allNetIds, _playerNetIds, clientIndex) => {
    const view = new Set<number>();
    const arr = [...allNetIds];
    for (let i = 0; i < arr.length; i++) {
      if ((arr[i] * 7 + clientIndex * 13) % 10 === 0) view.add(arr[i]);
    }
    return view;
  },
);
