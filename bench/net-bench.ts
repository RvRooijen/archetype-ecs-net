// Performance benchmark: archetype-ecs-net change tracking overhead
// Run with: npx tsx bench/net-bench.ts

import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder } from '../src/Protocol.js';

const COUNT = 100_000;
const FRAMES = 50;

const Position = component('BPos', { x: 'f32', y: 'f32' });
const Velocity = component('BVel', { vx: 'f32', vy: 'f32' });

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Velocity, name: 'Velocity' },
]);

const pad = (s: string | number, n: number) => String(s).padStart(n);

// ── 1. Baseline: raw ECS forEach ────────────────────────

function benchRaw() {
  const em = createEntityManager();
  for (let i = 0; i < COUNT; i++) {
    em.createEntityWith(Position, { x: i * 0.1, y: i * 0.1 }, Velocity, { vx: 1, vy: 1 });
  }
  for (let f = 0; f < 3; f++) {
    em.forEach([Position, Velocity], (a) => {
      const px = a.field(Position.x) as Float32Array;
      const py = a.field(Position.y) as Float32Array;
      const vx = a.field(Velocity.vx) as Float32Array;
      const vy = a.field(Velocity.vy) as Float32Array;
      for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i]; }
    });
  }
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    em.forEach([Position, Velocity], (a) => {
      const px = a.field(Position.x) as Float32Array;
      const py = a.field(Position.y) as Float32Array;
      const vx = a.field(Velocity.vx) as Float32Array;
      const vy = a.field(Velocity.vy) as Float32Array;
      for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i]; }
    });
  }
  return (performance.now() - t0) / FRAMES;
}

// ── 2. raw forEach + double-buffer diff (1% networked) ──
// ALL entities updated with raw forEach. Diff uses front vs back snapshot.

function benchTracked1Pct() {
  const em = createEntityManager();
  const networkedCount = Math.floor(COUNT * 0.01);
  for (let i = 0; i < networkedCount; i++) {
    em.createEntityWith(Position, { x: i * 0.1, y: i * 0.1 }, Velocity, { vx: 1, vy: 1 }, Networked);
  }
  for (let i = networkedCount; i < COUNT; i++) {
    em.createEntityWith(Position, { x: i * 0.1, y: i * 0.1 }, Velocity, { vx: 1, vy: 1 });
  }
  const differ = createSnapshotDiffer(em, registry);
  differ.diff(); // baseline

  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    // ALL entities via raw forEach (no em.set() needed!)
    em.forEach([Position, Velocity], (a) => {
      const px = a.field(Position.x) as Float32Array;
      const py = a.field(Position.y) as Float32Array;
      const vx = a.field(Velocity.vx) as Float32Array;
      const vy = a.field(Velocity.vy) as Float32Array;
      for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i]; }
    });

    differ.diff();
  }
  return (performance.now() - t0) / FRAMES;
}

// ── 3. raw forEach + diff + encode (1% networked) ───────

function benchTrackedEncode1Pct() {
  const em = createEntityManager();
  const networkedCount = Math.floor(COUNT * 0.01);
  for (let i = 0; i < networkedCount; i++) {
    em.createEntityWith(Position, { x: i * 0.1, y: i * 0.1 }, Velocity, { vx: 1, vy: 1 }, Networked);
  }
  for (let i = networkedCount; i < COUNT; i++) {
    em.createEntityWith(Position, { x: i * 0.1, y: i * 0.1 }, Velocity, { vx: 1, vy: 1 });
  }
  const differ = createSnapshotDiffer(em, registry);
  const encoder = new ProtocolEncoder();
  differ.diff(); // baseline

  let lastSize = 0;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    em.forEach([Position, Velocity], (a) => {
      const px = a.field(Position.x) as Float32Array;
      const py = a.field(Position.y) as Float32Array;
      const vx = a.field(Velocity.vx) as Float32Array;
      const vy = a.field(Velocity.vy) as Float32Array;
      for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i]; }
    });

    const delta = differ.diff();
    const buf = encoder.encodeDelta(delta, em, registry);
    lastSize = buf.byteLength;
  }
  return { ms: (performance.now() - t0) / FRAMES, bytes: lastSize };
}

// ── 4. raw forEach + diff (100% networked, worst case) ──

function benchTrackedAll() {
  const em = createEntityManager();
  for (let i = 0; i < COUNT; i++) {
    em.createEntityWith(Position, { x: i * 0.1, y: i * 0.1 }, Velocity, { vx: 1, vy: 1 }, Networked);
  }
  const differ = createSnapshotDiffer(em, registry);
  differ.diff(); // baseline

  const t0 = performance.now();
  for (let f = 0; f < 5; f++) {
    em.forEach([Position, Velocity], (a) => {
      const px = a.field(Position.x) as Float32Array;
      const py = a.field(Position.y) as Float32Array;
      const vx = a.field(Velocity.vx) as Float32Array;
      const vy = a.field(Velocity.vy) as Float32Array;
      for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i]; }
    });
    differ.diff();
  }
  return (performance.now() - t0) / 5;
}

// ── Run ─────────────────────────────────────────────────

console.log(`\n=== archetype-ecs-net Benchmark: ${(COUNT / 1e3).toFixed(0)}k entities ===\n`);

process.stdout.write('  Raw ECS forEach (100k)...');
const raw = benchRaw();
console.log(` ${raw.toFixed(2)} ms/frame`);

process.stdout.write('  forEach + diff (1k networked)...');
const d1 = benchTracked1Pct();
console.log(` ${d1.toFixed(2)} ms/frame`);

process.stdout.write('  forEach + diff + encode (1k networked)...');
const d2 = benchTrackedEncode1Pct();
console.log(` ${d2.ms.toFixed(2)} ms/frame (${(d2.bytes / 1024).toFixed(1)} KB wire)`);

process.stdout.write('  forEach + diff (100k networked, worst)...');
const da = benchTrackedAll();
console.log(` ${da.toFixed(1)} ms/frame`);

console.log('\n  ── Summary ──────────────────────────────────────────\n');
console.log(`  ${'Test'.padEnd(45)} ${'ms/frame'.padStart(10)}  ${'overhead'.padStart(10)}`);
console.log(`  ${'─'.repeat(70)}`);
console.log(`  ${'Raw ECS forEach (100k)'.padEnd(45)} ${pad(raw.toFixed(2), 10)}  ${pad('baseline', 10)}`);
console.log(`  ${'forEach + diff (1k networked)'.padEnd(45)} ${pad(d1.toFixed(2), 10)}  ${pad('+' + (d1 - raw).toFixed(2) + 'ms', 10)}`);
console.log(`  ${'forEach + diff + encode (1k networked)'.padEnd(45)} ${pad(d2.ms.toFixed(2), 10)}  ${pad('+' + (d2.ms - raw).toFixed(2) + 'ms', 10)}  ${(d2.bytes/1024).toFixed(1)} KB`);
console.log(`  ${'forEach + diff (100k networked, worst)'.padEnd(45)} ${pad(da.toFixed(1), 10)}  ${pad('+' + (da - raw).toFixed(1) + 'ms', 10)}`);
console.log();
