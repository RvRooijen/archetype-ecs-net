// Performance benchmark: archetype-ecs-net change tracking overhead
// Run with: npx tsx bench/net-bench.ts

import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder } from '../src/Protocol.js';

const COUNT = 2_000_000;
const FRAMES = 50;

// ── Components (8 registered, heavier data) ────────────

const Position  = component('BPos',    { x: 'f32', y: 'f32', z: 'f32' });
const Velocity  = component('BVel',    { vx: 'f32', vy: 'f32', vz: 'f32' });
const Rotation  = component('BRot',    { rx: 'f32', ry: 'f32', rz: 'f32', rw: 'f32' });
const Health    = component('BHp',     { hp: 'i32', maxHp: 'i32', armor: 'i32' });
const Combat    = component('BCombat', { damage: 'f32', range: 'f32', cooldown: 'f32', timer: 'f32' });
const Physics   = component('BPhys',   { mass: 'f32', drag: 'f32', bounce: 'f32' });
const AI        = component('BAI',     { state: 'u8', target: 'u16', aggro: 'f32', patrol: 'f32' });
const Buff      = component('BBuff',   { type: 'u8', duration: 'f32', strength: 'f32' });

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Velocity, name: 'Velocity' },
  { component: Rotation, name: 'Rotation' },
  { component: Health,   name: 'Health' },
  { component: Combat,   name: 'Combat' },
  { component: Physics,  name: 'Physics' },
  { component: AI,       name: 'AI' },
  { component: Buff,     name: 'Buff' },
]);

const pad = (s: string | number, n: number) => String(s).padStart(n);

// ── Archetype distribution (% of COUNT) ────────────────
//   Players       3%  — Pos, Vel, Rot, Health, Combat, Physics, Buff (7 components)
//   Projectiles  20%  — Pos, Vel, Physics (3 components, fast moving)
//   NPCs         10%  — Pos, Vel, Rot, Health, Combat, AI (6 components)
//   Mobs         12%  — Pos, Vel, Rot, Health, Combat, AI, Buff (7 components)
//   Particles     5%  — Pos, Vel (2 components, VFX, all update every frame)
//   Static       50%  — Pos, Rot (2 components, no updates)

const PLAYERS     = Math.floor(COUNT * 0.03);
const PROJECTILES = Math.floor(COUNT * 0.20);
const NPCS        = Math.floor(COUNT * 0.10);
const MOBS        = Math.floor(COUNT * 0.12);
const PARTICLES   = Math.floor(COUNT * 0.05);
const STATICS     = COUNT - PLAYERS - PROJECTILES - NPCS - MOBS - PARTICLES;

function createWorld(em: ReturnType<typeof createEntityManager>, networkedPct: number) {
  const netPlayers     = Math.floor(PLAYERS * networkedPct);
  const netProjectiles = Math.floor(PROJECTILES * networkedPct);
  const netNpcs        = Math.floor(NPCS * networkedPct);
  const netMobs        = Math.floor(MOBS * networkedPct);
  const netParticles   = Math.floor(PARTICLES * networkedPct);
  // statics are never networked (no updates)

  function spawnPlayers(from: number, to: number, net: boolean) {
    for (let i = from; i < to; i++) {
      const args: any[] = [
        Position, { x: i, y: 0, z: i }, Velocity, { vx: 1, vy: 0, vz: 1 },
        Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 }, Health, { hp: 100, maxHp: 100, armor: 10 },
        Combat, { damage: 25, range: 5, cooldown: 1, timer: 0 }, Physics, { mass: 80, drag: 0.1, bounce: 0 },
        Buff, { type: 0, duration: 30, strength: 1.5 },
      ];
      if (net) args.push(Networked);
      em.createEntityWith(...args);
    }
  }

  function spawnProjectiles(from: number, to: number, net: boolean) {
    for (let i = from; i < to; i++) {
      const args: any[] = [
        Position, { x: i, y: 1, z: 0 }, Velocity, { vx: 10, vy: 0, vz: 10 },
        Physics, { mass: 0.1, drag: 0.01, bounce: 0.5 },
      ];
      if (net) args.push(Networked);
      em.createEntityWith(...args);
    }
  }

  function spawnNpcs(from: number, to: number, net: boolean) {
    for (let i = from; i < to; i++) {
      const args: any[] = [
        Position, { x: i * 2, y: 0, z: i * 2 }, Velocity, { vx: 0.5, vy: 0, vz: 0.5 },
        Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 }, Health, { hp: 50, maxHp: 50, armor: 5 },
        Combat, { damage: 10, range: 3, cooldown: 2, timer: 0 },
        AI, { state: 1, target: 0, aggro: 0, patrol: 10 },
      ];
      if (net) args.push(Networked);
      em.createEntityWith(...args);
    }
  }

  function spawnMobs(from: number, to: number, net: boolean) {
    for (let i = from; i < to; i++) {
      const args: any[] = [
        Position, { x: i * 3, y: 0, z: i * 3 }, Velocity, { vx: 0.3, vy: 0, vz: 0.3 },
        Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 }, Health, { hp: 200, maxHp: 200, armor: 20 },
        Combat, { damage: 15, range: 2, cooldown: 3, timer: 0 },
        AI, { state: 0, target: 0, aggro: 0, patrol: 20 },
        Buff, { type: 1, duration: 60, strength: 2.0 },
      ];
      if (net) args.push(Networked);
      em.createEntityWith(...args);
    }
  }

  function spawnParticles(from: number, to: number, net: boolean) {
    for (let i = from; i < to; i++) {
      const args: any[] = [
        Position, { x: i * 0.1, y: 5, z: i * 0.1 }, Velocity, { vx: 3, vy: -1, vz: 3 },
      ];
      if (net) args.push(Networked);
      em.createEntityWith(...args);
    }
  }

  spawnPlayers(0, netPlayers, true);
  spawnPlayers(netPlayers, PLAYERS, false);
  spawnProjectiles(0, netProjectiles, true);
  spawnProjectiles(netProjectiles, PROJECTILES, false);
  spawnNpcs(0, netNpcs, true);
  spawnNpcs(netNpcs, NPCS, false);
  spawnMobs(0, netMobs, true);
  spawnMobs(netMobs, MOBS, false);
  spawnParticles(0, netParticles, true);
  spawnParticles(netParticles, PARTICLES, false);

  // Statics (never networked)
  for (let i = 0; i < STATICS; i++) {
    em.createEntityWith(
      Position, { x: i * 0.5, y: 0, z: i * 0.5 },
      Rotation, { rx: 0, ry: 0, rz: 0, rw: 1 },
    );
  }

  const netTotal = netPlayers + netProjectiles + netNpcs + netMobs + netParticles;
  return { netPlayers, netProjectiles, netNpcs, netMobs, netParticles, netTotal };
}

// Simulate a game tick: move, drag, combat, AI, buffs
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

  // AI patrol tick
  em.forEach([AI, Position], (a) => {
    const aggro  = a.field(AI.aggro) as Float32Array;
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

  // Buff duration tick
  em.forEach([Buff], (a) => {
    const dur = a.field(Buff.duration) as Float32Array;
    for (let i = 0; i < a.count; i++) {
      dur[i] -= 0.016;
    }
  });
}

// ── Generic bench runner ────────────────────────────────

function benchNet(pct: number, frames = FRAMES) {
  const em = createEntityManager();
  const info = createWorld(em, pct);
  const differ = createSnapshotDiffer(em, registry);
  const encoder = new ProtocolEncoder();
  differ.diffAndEncode(encoder); // baseline
  for (let f = 0; f < 3; f++) { gameTick(em); differ.diffAndEncode(encoder); } // warmup
  let lastSize = 0;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    gameTick(em);
    const buf = differ.diffAndEncode(encoder);
    lastSize = buf.byteLength;
  }
  return { ms: (performance.now() - t0) / frames, bytes: lastSize, net: info.netTotal };
}

function benchRaw() {
  const em = createEntityManager();
  createWorld(em, 0);
  for (let f = 0; f < 3; f++) gameTick(em); // warmup
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) gameTick(em);
  return (performance.now() - t0) / FRAMES;
}

// ── Run ─────────────────────────────────────────────────

const totalLabel = COUNT >= 1e6 ? `${(COUNT / 1e6).toFixed(0)}M` : `${(COUNT / 1e3).toFixed(0)}k`;
const fmtN = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
const fmtBytes = (b: number) => b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`;

console.log(`\n=== archetype-ecs-net Benchmark ===`);
console.log(`  ${totalLabel} entities · 6 archetypes · 8 components · 5 systems`);
console.log(`  Players ${fmtN(PLAYERS)} (7c) · Projectiles ${fmtN(PROJECTILES)} (3c) · NPCs ${fmtN(NPCS)} (6c) · Mobs ${fmtN(MOBS)} (7c) · Particles ${fmtN(PARTICLES)} (2c) · Static ${fmtN(STATICS)} (2c)\n`);

process.stdout.write(`  [1/5] Raw game tick (no net)...`);
const raw = benchRaw();
console.log(` ${raw.toFixed(2)} ms`);

process.stdout.write(`  [2/5] tick + diffAndEncode (1% networked)...`);
const f1 = benchNet(0.01);
console.log(` ${f1.ms.toFixed(2)} ms  (${fmtN(f1.net)} entities, ${fmtBytes(f1.bytes)} wire)`);

process.stdout.write(`  [3/5] tick + diffAndEncode (10% networked)...`);
const f10 = benchNet(0.10);
console.log(` ${f10.ms.toFixed(2)} ms  (${fmtN(f10.net)} entities, ${fmtBytes(f10.bytes)} wire)`);

process.stdout.write(`  [4/5] tick + diffAndEncode (50% networked)...`);
const f50 = benchNet(0.50, 10);
console.log(` ${f50.ms.toFixed(1)} ms  (${fmtN(f50.net)} entities, ${fmtBytes(f50.bytes)} wire)`);

process.stdout.write(`  [5/5] tick + diffAndEncode (100% dynamic, worst)...`);
const fa = benchNet(1.0, 5);
console.log(` ${fa.ms.toFixed(1)} ms  (${fmtN(fa.net)} entities, ${fmtBytes(fa.bytes)} wire)`);

console.log(`\n  ── Summary ─────────────────────────────────────────────────────────────\n`);
console.log(`  ${'Test'.padEnd(55)} ${'ms/frame'.padStart(10)}  ${'overhead'.padStart(10)}  ${'wire'.padStart(10)}`);
console.log(`  ${'─'.repeat(90)}`);
console.log(`  ${`Raw game tick (${totalLabel}, 6 archetypes)`.padEnd(55)} ${pad(raw.toFixed(2), 10)}  ${pad('baseline', 10)}`);
console.log(`  ${`+ diffAndEncode (${fmtN(f1.net)} net, 1%)`.padEnd(55)} ${pad(f1.ms.toFixed(2), 10)}  ${pad('+' + (f1.ms - raw).toFixed(2) + 'ms', 10)}  ${pad(fmtBytes(f1.bytes), 10)}`);
console.log(`  ${`+ diffAndEncode (${fmtN(f10.net)} net, 10%)`.padEnd(55)} ${pad(f10.ms.toFixed(2), 10)}  ${pad('+' + (f10.ms - raw).toFixed(2) + 'ms', 10)}  ${pad(fmtBytes(f10.bytes), 10)}`);
console.log(`  ${`+ diffAndEncode (${fmtN(f50.net)} net, 50%)`.padEnd(55)} ${pad(f50.ms.toFixed(1), 10)}  ${pad('+' + (f50.ms - raw).toFixed(1) + 'ms', 10)}  ${pad(fmtBytes(f50.bytes), 10)}`);
console.log(`  ${`+ diffAndEncode (${fmtN(fa.net)} net, worst)`.padEnd(55)} ${pad(fa.ms.toFixed(1), 10)}  ${pad('+' + (fa.ms - raw).toFixed(1) + 'ms', 10)}  ${pad(fmtBytes(fa.bytes), 10)}`);
console.log();
