import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked } from '../src/DirtyTracker.js';
import { createNetServer, createWsTransport } from '../src/NetServer.js';
import type { ServerTransport, TransportHandlers } from '../src/NetServer.js';
import { createNetClient } from '../src/NetClient.js';
import { ProtocolDecoder } from '../src/Protocol.js';
import { MSG_FULL, MSG_DELTA, MSG_CLIENT_ID, MSG_RECONNECT } from '../src/types.js';
import type { FullStateMessage, DeltaMessage, ClientId } from '../src/types.js';
import WebSocket from 'ws';

// ── Components ──────────────────────────────────────────

const Position = component('BPos', 'f32', ['x', 'y']);
const Health   = component('BHp', 'i32', ['hp', 'maxHp']);
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health,   name: 'Health' },
]);
const decoder = new ProtocolDecoder();

// ── Queuing transport ───────────────────────────────────
// Holds ALL messages until manually flushed — simulates a
// long HOL block where hundreds of ticks pile up.

function createQueuingTransport(): {
  transport: ServerTransport;
  flush(): void;
  queueSize(clientId: ClientId): number;
  totalQueued(): number;
} {
  const inner = createWsTransport();
  const queues = new Map<ClientId, ArrayBuffer[]>();
  let holdAll = false;

  return {
    transport: {
      async start(port, handlers) {
        return inner.start(port, handlers);
      },
      async stop() {
        queues.clear();
        return inner.stop();
      },
      send(clientId, data) {
        const firstByte = new Uint8Array(data)[0];
        // Always let handshake + full state through for connection setup
        if (!holdAll || firstByte === MSG_CLIENT_ID || firstByte === MSG_FULL) {
          inner.send(clientId, data);
          return;
        }
        let queue = queues.get(clientId);
        if (!queue) { queue = []; queues.set(clientId, queue); }
        queue.push(data);
      },
      broadcast(data) { inner.broadcast(data); },
    },

    flush() {
      for (const [clientId, queue] of queues) {
        for (const data of queue) inner.send(clientId, data);
        queue.length = 0;
      }
      holdAll = false;
    },

    queueSize(clientId) { return queues.get(clientId)?.length ?? 0; },
    totalQueued() {
      let n = 0;
      for (const q of queues.values()) n += q.length;
      return n;
    },

    // Call this AFTER client has connected and received full state
    get hold() { return holdAll; },
    set hold(v: boolean) { holdAll = v; },
  } as any;
}

// ── Helpers ─────────────────────────────────────────────

function createMessageReader(ws: WebSocket) {
  const queue: ArrayBuffer[] = [];
  const waiters: ((buf: ArrayBuffer) => void)[] = [];

  ws.on('message', (d: Buffer) => {
    const buf = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
    const waiter = waiters.shift();
    if (waiter) waiter(buf);
    else queue.push(buf);
  });

  return {
    recv(): Promise<ArrayBuffer> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(r => waiters.push(r));
    },
    tryRecv(ms = 100): Promise<ArrayBuffer | null> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(r => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          r(null);
        }, ms);
        const resolve = (buf: ArrayBuffer) => { clearTimeout(timer); r(buf); };
        waiters.push(resolve);
      });
    },
    drainAll(): ArrayBuffer[] {
      const result = [...queue];
      queue.length = 0;
      return result;
    },
    pending() { return queue.length; },
  };
}

function sendHandshake(ws: WebSocket, token = 0) {
  const buf = Buffer.alloc(5);
  buf.writeUint8(MSG_RECONNECT, 0);
  buf.writeUint32LE(token, 1);
  ws.send(buf);
}

async function connectNew(port: number) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>(r => ws.on('open', r));
  const reader = createMessageReader(ws);
  sendHandshake(ws, 0);

  const idBuf = await reader.recv();
  assert.equal(new Uint8Array(idBuf)[0], MSG_CLIENT_ID);
  return { ws, reader };
}

function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Test 1: 500 tick burst — decode + apply time ────────

it('burst-500: measure decode time for 500 queued deltas', async () => {
  const qt = createQueuingTransport() as any;
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19990 }, qt.transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Health, { hp: 100, maxHp: 100 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19990);
  await reader.recv(); // full state

  // Start holding
  qt.hold = true;

  // Run 500 ticks, each changing position
  for (let i = 1; i <= 500; i++) {
    em.set(e1, Position.x, i);
    em.set(e1, Position.y, i * 0.5);
    if (i % 10 === 0) em.set(e1, Health.hp, 100 - Math.floor(i / 10));
    server.tick();
  }

  assert.equal(qt.totalQueued(), 500, '500 deltas queued');

  // Flush everything — simulate TCP retransmit completing
  qt.flush();
  await wait(200); // give time for WS to deliver

  const messages = reader.drainAll();
  assert.equal(messages.length, 500, 'all 500 deltas received');

  // Measure decode time
  const t0 = performance.now();
  const decoded: DeltaMessage[] = [];
  for (const buf of messages) {
    decoded.push(decoder.decode(buf, registry) as DeltaMessage);
  }
  const decodeMs = performance.now() - t0;

  // Measure apply time (simulated — apply updates to a client EM)
  const clientEm = createEntityManager();
  const localEntity = clientEm.createEntityWith(Position, { x: 0, y: 0 }, Health, { hp: 100, maxHp: 100 });

  const t1 = performance.now();
  for (const delta of decoded) {
    for (const update of delta.updated) {
      if (update.data.x !== undefined) clientEm.set(localEntity, Position.x, update.data.x as number);
      if (update.data.y !== undefined) clientEm.set(localEntity, Position.y, update.data.y as number);
      if (update.data.hp !== undefined) clientEm.set(localEntity, Health.hp, update.data.hp as number);
    }
  }
  const applyMs = performance.now() - t1;

  const totalMs = decodeMs + applyMs;

  // At 60fps, one frame = 16.6ms. Let's see how many frames this burst eats.
  const framesBlocked = totalMs / 16.6;

  console.log(`  500 deltas burst:`);
  console.log(`    decode: ${decodeMs.toFixed(2)}ms`);
  console.log(`    apply:  ${applyMs.toFixed(2)}ms`);
  console.log(`    total:  ${totalMs.toFixed(2)}ms (~${framesBlocked.toFixed(1)} frames at 60fps)`);
  console.log(`    avg per delta: ${(totalMs / 500).toFixed(3)}ms`);

  // Final state should match
  assert.equal(clientEm.get(localEntity, Position.x), 500);
  assert.equal(clientEm.get(localEntity, Position.y), 250);
  assert.equal(clientEm.get(localEntity, Health.hp), 50);

  // Only the LAST values matter — the first 499 were wasted work
  const wastedOps = decoded.reduce((sum, d) => sum + d.updated.length, 0) - 1;
  console.log(`    wasted update operations: ${wastedOps}/500`);

  ws.terminate();
  await server.stop();
});

// ── Test 2: 500 ticks with entity churn ─────────────────

it('burst-500: entity create/destroy churn during burst', async () => {
  const qt = createQueuingTransport() as any;
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19991 }, qt.transport);
  const anchor = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19991);
  await reader.recv(); // full state

  qt.hold = true;

  // Simulate 500 ticks with entity churn — NPCs spawning and dying
  const tempEntities: number[] = [];
  let totalCreates = 0;
  let totalDestroys = 0;

  for (let i = 1; i <= 500; i++) {
    // Always update anchor so every tick produces a delta
    em.set(anchor, Position.x, i);

    // Every 5 ticks: spawn a temp entity
    if (i % 5 === 0) {
      const temp = em.createEntityWith(Position, { x: i, y: i }, Networked);
      tempEntities.push(temp);
      totalCreates++;
    }
    // Every 7 ticks: destroy the oldest temp entity if any
    if (i % 7 === 0 && tempEntities.length > 0) {
      em.destroyEntity(tempEntities.shift()!);
      totalDestroys++;
    }
    server.tick();
  }

  assert.equal(qt.totalQueued(), 500);

  qt.flush();
  await wait(200);

  const messages = reader.drainAll();
  assert.equal(messages.length, 500);

  // Decode all and count operations
  let creates = 0;
  let destroys = 0;
  let updates = 0;
  let totalBytes = 0;

  const t0 = performance.now();
  for (const buf of messages) {
    totalBytes += buf.byteLength;
    const delta = decoder.decode(buf, registry) as DeltaMessage;
    creates += delta.created.size;
    destroys += delta.destroyed.length;
    updates += delta.updated.length;
  }
  const decodeMs = performance.now() - t0;

  // Count entities that were created AND destroyed during the burst
  // (completely wasted on the client — never visible to the player)
  const netCreatesWasted = Math.min(totalCreates, totalDestroys);

  console.log(`  500 ticks entity churn:`);
  console.log(`    total creates: ${creates}, destroys: ${destroys}, updates: ${updates}`);
  console.log(`    entities created & destroyed within burst: ${netCreatesWasted} (wasted allocations)`);
  console.log(`    total bytes: ${(totalBytes / 1024).toFixed(1)}KB`);
  console.log(`    decode time: ${decodeMs.toFixed(2)}ms`);

  assert.equal(creates, totalCreates);
  assert.equal(destroys, totalDestroys);

  ws.terminate();
  await server.stop();
});

// ── Test 3: Memory pressure — many entities in burst ────

it('burst-500: 100 entities all updating every tick = decode pressure', async () => {
  const qt = createQueuingTransport() as any;
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19992 }, qt.transport);

  // Create 100 entities
  const entities: number[] = [];
  for (let i = 0; i < 100; i++) {
    entities.push(em.createEntityWith(Position, { x: i, y: i }, Networked));
  }
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19992);
  await reader.recv(); // full state (100 entities)

  qt.hold = true;

  // 500 ticks, each updating ALL 100 entities
  for (let tick = 1; tick <= 500; tick++) {
    for (let i = 0; i < 100; i++) {
      em.set(entities[i], Position.x, tick + i);
    }
    server.tick();
  }

  assert.equal(qt.totalQueued(), 500);

  qt.flush();
  await wait(300);

  const messages = reader.drainAll();
  assert.equal(messages.length, 500);

  let totalUpdates = 0;
  let totalBytes = 0;

  const t0 = performance.now();
  for (const buf of messages) {
    totalBytes += buf.byteLength;
    const delta = decoder.decode(buf, registry) as DeltaMessage;
    totalUpdates += delta.updated.length;
  }
  const decodeMs = performance.now() - t0;

  // 500 ticks × 100 entities = 50,000 update operations
  console.log(`  500 ticks × 100 entities:`);
  console.log(`    total update operations: ${totalUpdates}`);
  console.log(`    total bytes: ${(totalBytes / 1024).toFixed(1)}KB`);
  console.log(`    decode time: ${decodeMs.toFixed(2)}ms (~${(decodeMs / 16.6).toFixed(1)} frames at 60fps)`);
  console.log(`    avg per delta: ${(decodeMs / 500).toFixed(3)}ms`);
  console.log(`    useful operations: 100 (only last tick matters)`);
  console.log(`    wasted operations: ${totalUpdates - 100}`);

  assert.equal(totalUpdates, 500 * 100, 'every tick updates all 100 entities');

  ws.terminate();
  await server.stop();
});

// ── Test 4: What an ideal system would do ───────────────
// Compare: process all 500 deltas vs. skip to last.
// Shows the theoretical improvement of delta collapsing.

it('burst-500: theoretical comparison — process all vs skip to latest', async () => {
  const qt = createQueuingTransport() as any;
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19993 }, qt.transport);

  const ENTITY_COUNT = 50;
  const TICK_COUNT = 500;

  const entities: number[] = [];
  for (let i = 0; i < ENTITY_COUNT; i++) {
    entities.push(em.createEntityWith(Position, { x: 0, y: 0 }, Networked));
  }
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19993);
  await reader.recv(); // full state

  qt.hold = true;

  for (let tick = 1; tick <= TICK_COUNT; tick++) {
    for (let i = 0; i < ENTITY_COUNT; i++) {
      em.set(entities[i], Position.x, tick * 10 + i);
      em.set(entities[i], Position.y, tick * 5 + i);
    }
    server.tick();
  }

  qt.flush();
  await wait(300);

  const messages = reader.drainAll();

  // Approach A: process every delta (what TCP forces you to do)
  const clientEmA = createEntityManager();
  const localA: number[] = [];
  for (let i = 0; i < ENTITY_COUNT; i++) {
    localA.push(clientEmA.createEntityWith(Position, { x: 0, y: 0 }));
  }

  const tA0 = performance.now();
  for (const buf of messages) {
    const delta = decoder.decode(buf, registry) as DeltaMessage;
    for (const update of delta.updated) {
      const local = localA[update.netId - 1]; // netId is 1-based
      if (local === undefined) continue;
      if (update.data.x !== undefined) clientEmA.set(local, Position.x, update.data.x as number);
      if (update.data.y !== undefined) clientEmA.set(local, Position.y, update.data.y as number);
    }
  }
  const msAll = performance.now() - tA0;

  // Approach B: only process the LAST delta (what you could do with UDP)
  const clientEmB = createEntityManager();
  const localB: number[] = [];
  for (let i = 0; i < ENTITY_COUNT; i++) {
    localB.push(clientEmB.createEntityWith(Position, { x: 0, y: 0 }));
  }

  const tB0 = performance.now();
  const lastBuf = messages[messages.length - 1];
  const lastDelta = decoder.decode(lastBuf, registry) as DeltaMessage;
  for (const update of lastDelta.updated) {
    const local = localB[update.netId - 1];
    if (local === undefined) continue;
    if (update.data.x !== undefined) clientEmB.set(local, Position.x, update.data.x as number);
    if (update.data.y !== undefined) clientEmB.set(local, Position.y, update.data.y as number);
  }
  const msLast = performance.now() - tB0;

  // Both should arrive at the same final state
  for (let i = 0; i < ENTITY_COUNT; i++) {
    assert.equal(clientEmA.get(localA[i], Position.x), clientEmB.get(localB[i], Position.x));
    assert.equal(clientEmA.get(localA[i], Position.y), clientEmB.get(localB[i], Position.y));
  }

  const speedup = msAll / msLast;
  console.log(`  ${TICK_COUNT} ticks × ${ENTITY_COUNT} entities — process all vs last only:`);
  console.log(`    process all:  ${msAll.toFixed(2)}ms`);
  console.log(`    last only:    ${msLast.toFixed(2)}ms`);
  console.log(`    speedup:      ${speedup.toFixed(1)}x`);
  console.log(`    same result:  yes`);

  ws.terminate();
  await server.stop();
});
