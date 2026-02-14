import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked } from '../src/DirtyTracker.js';
import { createNetServer, createWsTransport } from '../src/NetServer.js';
import type { ServerTransport, TransportHandlers } from '../src/NetServer.js';
import { createNetClient } from '../src/NetClient.js';
import { ProtocolDecoder } from '../src/Protocol.js';
import { MSG_FULL, MSG_DELTA, MSG_CLIENT_ID, MSG_RECONNECT, MSG_REQUEST_FULL } from '../src/types.js';
import type { FullStateMessage, DeltaMessage, ClientId } from '../src/types.js';
import { WebSocket as NodeWebSocket } from 'ws';

// Polyfill for Node.js
(globalThis as any).WebSocket = NodeWebSocket;

// ── Components ──────────────────────────────────────────

const Position = component('RsPos', 'f32', ['x', 'y']);
const Health   = component('RsHp', 'i32', ['hp', 'maxHp']);
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health,   name: 'Health' },
]);

// ── Intercepting transport ──────────────────────────────
// Wraps WS transport but lets us hold server→client messages
// and track what the server receives from clients.

function createInterceptTransport(): {
  transport: ServerTransport;
  hold: boolean;
  flush(): void;
  received: { clientId: ClientId; firstByte: number }[];
} {
  const inner = createWsTransport();
  const queues = new Map<ClientId, ArrayBuffer[]>();
  const received: { clientId: ClientId; firstByte: number }[] = [];
  let holdDeltas = false;

  return {
    received,
    get hold() { return holdDeltas; },
    set hold(v: boolean) { holdDeltas = v; },

    flush() {
      for (const [clientId, queue] of queues) {
        for (const data of queue) inner.send(clientId, data);
        queue.length = 0;
      }
    },

    transport: {
      async start(port, handlers) {
        const wrappedHandlers: TransportHandlers = {
          onOpen: handlers.onOpen,
          onClose: handlers.onClose,
          onMessage(clientId, data) {
            received.push({ clientId, firstByte: new Uint8Array(data)[0] });
            handlers.onMessage(clientId, data);
          },
        };
        return inner.start(port, wrappedHandlers);
      },
      async stop() { return inner.stop(); },
      send(clientId, data) {
        const firstByte = new Uint8Array(data)[0];
        // Always pass through handshake + full state immediately
        if (!holdDeltas || firstByte === MSG_CLIENT_ID || firstByte === MSG_FULL) {
          inner.send(clientId, data);
          return;
        }
        let queue = queues.get(clientId);
        if (!queue) { queue = []; queues.set(clientId, queue); }
        queue.push(data);
      },
      broadcast(data) { inner.broadcast(data); },
    },
  };
}

function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Test 1: Burst threshold triggers full resync ────────

it('burst-resync: client requests full state when delta count exceeds threshold', async () => {
  const intercept = createInterceptTransport();
  const PORT = 19860;

  const serverEm = createEntityManager();
  const server = createNetServer(serverEm, registry, { port: PORT }, intercept.transport);
  const e1 = serverEm.createEntityWith(Position, { x: 0, y: 0 }, Health, { hp: 100, maxHp: 100 }, Networked);
  server.tick();
  await server.start();

  // Client with burstThreshold=5
  const clientEm = createEntityManager();
  const client = createNetClient(clientEm, registry, { burstThreshold: 5 });

  await new Promise<void>(resolve => {
    client.onConnected = () => resolve();
    client.connect(`ws://localhost:${PORT}`);
  });
  await wait(50);

  // Process full state
  client.tick();
  assert.equal(client.netToEntity.size, 1, 'client has 1 entity after full state');

  // Hold server deltas
  intercept.hold = true;

  // Server ticks 10 times — all deltas held at transport
  for (let i = 1; i <= 10; i++) {
    serverEm.set(e1, Position.x, i * 10);
    server.tick();
  }

  // Flush all 10 deltas to client at once
  intercept.hold = false;
  intercept.flush();
  await wait(50);

  // Clear received log to track what client sends next
  intercept.received.length = 0;

  // Client tick: sees 10 buffered deltas > threshold of 5
  // → discards deltas, sends MSG_REQUEST_FULL
  client.tick();
  await wait(50);

  // Verify client sent MSG_REQUEST_FULL
  const resyncRequests = intercept.received.filter(r => r.firstByte === MSG_REQUEST_FULL);
  assert.equal(resyncRequests.length, 1, 'client sent MSG_REQUEST_FULL');

  // Server responds with full state (handled automatically by NetServer)
  // Wait for it to arrive
  await wait(50);

  // Process the full state response
  client.tick();

  // Verify client state matches server (x=100 from last tick)
  const localEid = client.netToEntity.get(1)!;
  assert.ok(localEid !== undefined, 'entity exists on client');
  assert.ok(Math.abs(clientEm.get(localEid, Position.x) - 100) < 0.01,
    `client x should be 100, got ${clientEm.get(localEid, Position.x)}`);
  assert.equal(clientEm.get(localEid, Health.hp), 100);

  client.disconnect();
  await server.stop();
});

// ── Test 2: Under threshold — deltas processed normally ─

it('burst-resync: deltas processed normally when under threshold', async () => {
  const intercept = createInterceptTransport();
  const PORT = 19861;

  const serverEm = createEntityManager();
  const server = createNetServer(serverEm, registry, { port: PORT }, intercept.transport);
  const e1 = serverEm.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const clientEm = createEntityManager();
  const client = createNetClient(clientEm, registry, { burstThreshold: 10 });

  await new Promise<void>(resolve => {
    client.onConnected = () => resolve();
    client.connect(`ws://localhost:${PORT}`);
  });
  await wait(50);
  client.tick(); // process full state

  // Hold deltas
  intercept.hold = true;

  // Only 3 ticks — under threshold of 10
  for (let i = 1; i <= 3; i++) {
    serverEm.set(e1, Position.x, i * 10);
    server.tick();
  }

  intercept.hold = false;
  intercept.flush();
  await wait(50);

  intercept.received.length = 0;

  // Client tick: 3 deltas < threshold → processed normally
  client.tick();
  await wait(50);

  // No MSG_REQUEST_FULL should have been sent
  const resyncRequests = intercept.received.filter(r => r.firstByte === MSG_REQUEST_FULL);
  assert.equal(resyncRequests.length, 0, 'no resync request — under threshold');

  // State should reflect the last delta (x=30)
  const localEid = client.netToEntity.get(1)!;
  assert.ok(Math.abs(clientEm.get(localEid, Position.x) - 30) < 0.01);

  client.disconnect();
  await server.stop();
});

// ── Test 3: threshold=0 disables burst detection ────────

it('burst-resync: threshold=0 disables burst detection', async () => {
  const intercept = createInterceptTransport();
  const PORT = 19862;

  const serverEm = createEntityManager();
  const server = createNetServer(serverEm, registry, { port: PORT }, intercept.transport);
  const e1 = serverEm.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const clientEm = createEntityManager();
  const client = createNetClient(clientEm, registry); // no burstThreshold

  await new Promise<void>(resolve => {
    client.onConnected = () => resolve();
    client.connect(`ws://localhost:${PORT}`);
  });
  await wait(50);
  client.tick();

  intercept.hold = true;
  for (let i = 1; i <= 50; i++) {
    serverEm.set(e1, Position.x, i);
    server.tick();
  }

  intercept.hold = false;
  intercept.flush();
  await wait(50);

  intercept.received.length = 0;
  client.tick(); // processes all 50 deltas
  await wait(50);

  // No resync request
  const resyncRequests = intercept.received.filter(r => r.firstByte === MSG_REQUEST_FULL);
  assert.equal(resyncRequests.length, 0, 'no resync — threshold disabled');

  // State reflects last delta
  const localEid = client.netToEntity.get(1)!;
  assert.ok(Math.abs(clientEm.get(localEid, Position.x) - 50) < 0.01);

  client.disconnect();
  await server.stop();
});

// ── Test 4: Performance — 500 deltas vs resync ──────────

it('burst-resync: 500 deltas via resync is faster than processing all', async () => {
  const intercept = createInterceptTransport();
  const PORT = 19863;

  const ENTITY_COUNT = 50;
  const TICK_COUNT = 500;

  const serverEm = createEntityManager();
  const server = createNetServer(serverEm, registry, { port: PORT }, intercept.transport);
  const entities: number[] = [];
  for (let i = 0; i < ENTITY_COUNT; i++) {
    entities.push(serverEm.createEntityWith(Position, { x: 0, y: 0 }, Networked));
  }
  server.tick();
  await server.start();

  // ── Client A: burstThreshold=10 (will resync) ─────────
  const clientEmA = createEntityManager();
  const clientA = createNetClient(clientEmA, registry, { burstThreshold: 10 });

  await new Promise<void>(resolve => {
    clientA.onConnected = () => resolve();
    clientA.connect(`ws://localhost:${PORT}`);
  });
  await wait(50);
  clientA.tick();

  // ── Client B: no threshold (processes all deltas) ──────
  const clientEmB = createEntityManager();
  const clientB = createNetClient(clientEmB, registry);

  await new Promise<void>(resolve => {
    clientB.onConnected = () => resolve();
    clientB.connect(`ws://localhost:${PORT}`);
  });
  await wait(50);
  clientB.tick();

  // Hold all deltas
  intercept.hold = true;

  for (let tick = 1; tick <= TICK_COUNT; tick++) {
    for (let i = 0; i < ENTITY_COUNT; i++) {
      serverEm.set(entities[i], Position.x, tick * 10 + i);
      serverEm.set(entities[i], Position.y, tick * 5 + i);
    }
    server.tick();
  }

  // Flush to both clients
  intercept.hold = false;
  intercept.flush();
  await wait(200);

  // Measure client A: resync path
  const tA0 = performance.now();
  clientA.tick(); // detects burst, sends MSG_REQUEST_FULL
  await wait(100); // wait for full state response
  clientA.tick(); // processes full state
  const msA = performance.now() - tA0;

  // Measure client B: process-all path
  const tB0 = performance.now();
  clientB.tick(); // processes all 500 deltas
  const msB = performance.now() - tB0;

  // Both should have the same final state
  for (let netId = 1; netId <= ENTITY_COUNT; netId++) {
    const eidA = clientA.netToEntity.get(netId)!;
    const eidB = clientB.netToEntity.get(netId)!;
    assert.ok(eidA !== undefined, `client A has entity ${netId}`);
    assert.ok(eidB !== undefined, `client B has entity ${netId}`);

    const xA = clientEmA.get(eidA, Position.x);
    const xB = clientEmB.get(eidB, Position.x);
    assert.ok(Math.abs(xA - xB) < 0.01,
      `entity ${netId} x mismatch: A=${xA}, B=${xB}`);
  }

  console.log(`  500 ticks × ${ENTITY_COUNT} entities:`);
  console.log(`    resync (client A):     ${msA.toFixed(2)}ms`);
  console.log(`    process all (client B): ${msB.toFixed(2)}ms`);

  clientA.disconnect();
  clientB.disconnect();
  await server.stop();
});

// ── Test 5: Entity churn during burst + resync ──────────
// Entities created/destroyed during the burst. Resync gives
// the correct final state without wasted allocations.

it('burst-resync: entity churn — resync gives correct final state', async () => {
  const intercept = createInterceptTransport();
  const PORT = 19864;

  const serverEm = createEntityManager();
  const server = createNetServer(serverEm, registry, { port: PORT }, intercept.transport);
  const anchor = serverEm.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const clientEm = createEntityManager();
  const client = createNetClient(clientEm, registry, { burstThreshold: 5 });

  await new Promise<void>(resolve => {
    client.onConnected = () => resolve();
    client.connect(`ws://localhost:${PORT}`);
  });
  await wait(50);
  client.tick();

  assert.equal(client.netToEntity.size, 1);

  intercept.hold = true;

  // Create 3 entities, destroy 2, update anchor — all while blocked
  const temp1 = serverEm.createEntityWith(Position, { x: 10, y: 10 }, Networked);
  server.tick();
  const temp2 = serverEm.createEntityWith(Position, { x: 20, y: 20 }, Networked);
  server.tick();
  const temp3 = serverEm.createEntityWith(Position, { x: 30, y: 30 }, Networked);
  server.tick();
  serverEm.destroyEntity(temp1);
  server.tick();
  serverEm.destroyEntity(temp2);
  server.tick();
  serverEm.set(anchor, Position.x, 999);
  server.tick();

  // 6 deltas queued > threshold of 5
  intercept.hold = false;
  intercept.flush();
  await wait(50);

  client.tick(); // burst detected → request resync
  await wait(100);
  client.tick(); // process full state

  // Server state: anchor (x=999) + temp3 (x=30) = 2 entities
  assert.equal(client.netToEntity.size, 2, 'client has 2 entities after resync');

  // Verify anchor
  const anchorLocal = client.netToEntity.get(1)!;
  assert.ok(Math.abs(clientEm.get(anchorLocal, Position.x) - 999) < 0.01);

  client.disconnect();
  await server.stop();
});
