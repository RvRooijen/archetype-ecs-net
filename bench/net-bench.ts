// Performance benchmark: archetype-ecs-net change tracking overhead
// Run with: npx tsx bench/net-bench.ts

import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder } from '../src/Protocol.js';

const COUNT = 1_000_000;
const FRAMES = 50;

// ── Components (6 registered, heavier data) ────────────

const Position  = component('BPos',    { x: 'f32', y: 'f32', z: 'f32' });
const Velocity  = component('BVel',    { vx: 'f32', vy: 'f32', vz: 'f32' });
const Rotation  = component('BRot',    { rx: 'f32', ry: 'f32', rz: 'f32', rw: 'f32' });
const Health    = component('BHp',     { hp: 'i32', maxHp: 'i32', armor: 'i32' });
const Combat    = component('BCombat', { damage: 'f32', range: 'f32', cooldown: 'f32', timer: 'f32' });
const Physics   = component('BPhys',   { mass: 'f32', drag: 'f32', bounce: 'f32' });

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Velocity, name: 'Velocity' },
  { component: Rotation, name: 'Rotation' },
  { component: Health,   name: 'Health' },
  { component: Combat,   name: 'Combat' },
  { component: Physics,  name: 'Physics' },
]);

const pad = (s: string | number, n: number) => String(s).padStart(n);

// ── Archetype distribution (% of COUNT) ────────────────
//   Players     5%  — Pos, Vel, Rot, Health, Combat, Physics (all 6)
//   Projectiles 25% — Pos, Vel, Physics (3 components, fast moving)
//   NPCs        10% — Pos, Vel, Rot, Health, Combat (5 components)
//   Static      60% — Pos, Rot (2 components, no updates)

const PLAYERS     = Math.floor(COUNT * 0.05);
const PROJECTILES = Math.floor(COUNT * 0.25);
const NPCS        = Math.floor(COUNT * 0.10);
const STATICS     = COUNT - PLAYERS - PROJECTILES - NPCS;

function createWorld(em: ReturnType<typeof createEntityManager>, networkedPct: number) {
  const netPlayers     = Math.floor(PLAYERS * networkedPct);
  const netProjectiles = Math.floor(PROJECTILES * networkedPct);
  const netNpcs        = Math.floor(NPCS * networkedPct);
  // statics are never networked (no updates)

  // Players (networked first)
  for (let i = 0; i < netPlayers; i++) {
    em.createEntityWith(
      Position, { x: i, y: 0, z: i }, Velocity, { vx: 1, vy: 0, vz: 1 },
      Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 }, Health, { hp: 100, maxHp: 100, armor: 10 },
      Combat, { damage: 25, range: 5, cooldown: 1, timer: 0 }, Physics, { mass: 80, drag: 0.1, bounce: 0 },
      Networked,
    );
  }
  for (let i = netPlayers; i < PLAYERS; i++) {
    em.createEntityWith(
      Position, { x: i, y: 0, z: i }, Velocity, { vx: 1, vy: 0, vz: 1 },
      Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 }, Health, { hp: 100, maxHp: 100, armor: 10 },
      Combat, { damage: 25, range: 5, cooldown: 1, timer: 0 }, Physics, { mass: 80, drag: 0.1, bounce: 0 },
    );
  }

  // Projectiles (networked first)
  for (let i = 0; i < netProjectiles; i++) {
    em.createEntityWith(
      Position, { x: i, y: 1, z: 0 }, Velocity, { vx: 10, vy: 0, vz: 10 },
      Physics, { mass: 0.1, drag: 0.01, bounce: 0.5 },
      Networked,
    );
  }
  for (let i = netProjectiles; i < PROJECTILES; i++) {
    em.createEntityWith(
      Position, { x: i, y: 1, z: 0 }, Velocity, { vx: 10, vy: 0, vz: 10 },
      Physics, { mass: 0.1, drag: 0.01, bounce: 0.5 },
    );
  }

  // NPCs (networked first)
  for (let i = 0; i < netNpcs; i++) {
    em.createEntityWith(
      Position, { x: i * 2, y: 0, z: i * 2 }, Velocity, { vx: 0.5, vy: 0, vz: 0.5 },
      Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 }, Health, { hp: 50, maxHp: 50, armor: 5 },
      Combat, { damage: 10, range: 3, cooldown: 2, timer: 0 },
      Networked,
    );
  }
  for (let i = netNpcs; i < NPCS; i++) {
    em.createEntityWith(
      Position, { x: i * 2, y: 0, z: i * 2 }, Velocity, { vx: 0.5, vy: 0, vz: 0.5 },
      Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 }, Health, { hp: 50, maxHp: 50, armor: 5 },
      Combat, { damage: 10, range: 3, cooldown: 2, timer: 0 },
    );
  }

  // Statics (never networked)
  for (let i = 0; i < STATICS; i++) {
    em.createEntityWith(
      Position, { x: i * 0.5, y: 0, z: i * 0.5 },
      Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 },
    );
  }

  return { netPlayers, netProjectiles, netNpcs, netTotal: netPlayers + netProjectiles + netNpcs };
}

// Simulate a game tick: move entities with Velocity, tick combat timers
function gameTick(em: ReturnType<typeof createEntityManager>) {
  // Move all entities with Position + Velocity
  em.forEach([Position, Velocity], (a) => {
    const px = a.field(Position.x) as Float32Array;
    const py = a.field(Position.y) as Float32Array;
    const pz = a.field(Position.z) as Float32Array;
    const vx = a.field(Velocity.vx) as Float32Array;
    const vy = a.field(Velocity.vy) as Float32Array;
    const vz = a.field(Velocity.vz) as Float32Array;
    for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i]; pz[i] += vz[i]; }
  });

  // Apply drag to entities with Physics + Velocity
  em.forEach([Velocity, Physics], (a) => {
    const vx = a.field(Velocity.vx) as Float32Array;
    const vy = a.field(Velocity.vy) as Float32Array;
    const vz = a.field(Velocity.vz) as Float32Array;
    const drag = a.field(Physics.drag) as Float32Array;
    for (let i = 0; i < a.count; i++) {
      const d = 1 - drag[i];
      vx[i] *= d; vy[i] *= d; vz[i] *= d;
    }
  });

  // Tick combat cooldowns
  em.forEach([Combat], (a) => {
    const timer = a.field(Combat.timer) as Float32Array;
    const cd    = a.field(Combat.cooldown) as Float32Array;
    for (let i = 0; i < a.count; i++) {
      timer[i] += 0.016;
      if (timer[i] >= cd[i]) timer[i] = 0;
    }
  });
}

// ── 1. Baseline: raw game tick, no networking ──────────

function benchRaw() {
  const em = createEntityManager();
  createWorld(em, 0);
  for (let f = 0; f < 3; f++) gameTick(em); // warmup
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) gameTick(em);
  return (performance.now() - t0) / FRAMES;
}

// ── 2. game tick + diffAndEncode (1% networked) ─────────

function benchFused1Pct() {
  const em = createEntityManager();
  const info = createWorld(em, 0.01);
  const differ = createSnapshotDiffer(em, registry);
  const encoder = new ProtocolEncoder();
  differ.diffAndEncode(encoder); // baseline
  let lastSize = 0;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    gameTick(em);
    const buf = differ.diffAndEncode(encoder);
    lastSize = buf.byteLength;
  }
  return { ms: (performance.now() - t0) / FRAMES, bytes: lastSize, net: info.netTotal };
}

// ── 3. game tick + diffAndEncode (10% networked) ────────

function benchFused10Pct() {
  const em = createEntityManager();
  const info = createWorld(em, 0.10);
  const differ = createSnapshotDiffer(em, registry);
  const encoder = new ProtocolEncoder();
  differ.diffAndEncode(encoder); // baseline
  let lastSize = 0;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    gameTick(em);
    const buf = differ.diffAndEncode(encoder);
    lastSize = buf.byteLength;
  }
  return { ms: (performance.now() - t0) / FRAMES, bytes: lastSize, net: info.netTotal };
}

// ── 4. game tick + diffAndEncode (100% dynamic, worst case) ──

function benchFusedAllDynamic() {
  const em = createEntityManager();
  const info = createWorld(em, 1.0);
  const differ = createSnapshotDiffer(em, registry);
  const encoder = new ProtocolEncoder();
  differ.diffAndEncode(encoder); // baseline
  let lastSize = 0;
  const frames = 5; // fewer frames, this is expensive
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    gameTick(em);
    const buf = differ.diffAndEncode(encoder);
    lastSize = buf.byteLength;
  }
  return { ms: (performance.now() - t0) / frames, bytes: lastSize, net: info.netTotal };
}

// ── Run ─────────────────────────────────────────────────

const totalLabel = COUNT >= 1e6 ? `${(COUNT / 1e6).toFixed(0)}M` : `${(COUNT / 1e3).toFixed(0)}k`;
const fmtN = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;

console.log(`\n=== archetype-ecs-net Benchmark ===`);
console.log(`  ${totalLabel} entities · 4 archetypes · 6 components`);
console.log(`  Players ${fmtN(PLAYERS)} (6c) · Projectiles ${fmtN(PROJECTILES)} (3c) · NPCs ${fmtN(NPCS)} (5c) · Static ${fmtN(STATICS)} (2c)\n`);

process.stdout.write(`  [1/4] Raw game tick (no net)...`);
const raw = benchRaw();
console.log(` ${raw.toFixed(2)} ms`);

process.stdout.write(`  [2/4] tick + diffAndEncode (1% networked)...`);
const f1 = benchFused1Pct();
console.log(` ${f1.ms.toFixed(2)} ms  (${fmtN(f1.net)} entities, ${(f1.bytes / 1024).toFixed(1)} KB wire)`);

process.stdout.write(`  [3/4] tick + diffAndEncode (10% networked)...`);
const f10 = benchFused10Pct();
console.log(` ${f10.ms.toFixed(2)} ms  (${fmtN(f10.net)} entities, ${(f10.bytes / 1024).toFixed(1)} KB wire)`);

process.stdout.write(`  [4/4] tick + diffAndEncode (100% dynamic, worst)...`);
const fa = benchFusedAllDynamic();
console.log(` ${fa.ms.toFixed(1)} ms  (${fmtN(fa.net)} entities, ${(fa.bytes / 1024).toFixed(1)} KB wire)`);

console.log(`\n  ── Summary ─────────────────────────────────────────────────────────────\n`);
console.log(`  ${'Test'.padEnd(55)} ${'ms/frame'.padStart(10)}  ${'overhead'.padStart(10)}  ${'wire'.padStart(10)}`);
console.log(`  ${'─'.repeat(90)}`);
console.log(`  ${`Raw game tick (${totalLabel}, 4 archetypes)`.padEnd(55)} ${pad(raw.toFixed(2), 10)}  ${pad('baseline', 10)}`);
console.log(`  ${`+ diffAndEncode (${fmtN(f1.net)} net, 1%)`.padEnd(55)} ${pad(f1.ms.toFixed(2), 10)}  ${pad('+' + (f1.ms - raw).toFixed(2) + 'ms', 10)}  ${pad((f1.bytes / 1024).toFixed(1) + ' KB', 10)}`);
console.log(`  ${`+ diffAndEncode (${fmtN(f10.net)} net, 10%)`.padEnd(55)} ${pad(f10.ms.toFixed(2), 10)}  ${pad('+' + (f10.ms - raw).toFixed(2) + 'ms', 10)}  ${pad((f10.bytes / 1024).toFixed(1) + ' KB', 10)}`);
console.log(`  ${`+ diffAndEncode (${fmtN(fa.net)} net, worst)`.padEnd(55)} ${pad(fa.ms.toFixed(1), 10)}  ${pad('+' + (fa.ms - raw).toFixed(1) + 'ms', 10)}  ${pad((fa.bytes / 1024).toFixed(1) + ' KB', 10)}`);
console.log();
