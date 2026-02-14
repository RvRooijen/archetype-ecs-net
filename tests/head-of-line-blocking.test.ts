import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked } from '../src/DirtyTracker.js';
import { createNetServer, createWsTransport } from '../src/NetServer.js';
import type { ServerTransport, TransportHandlers } from '../src/NetServer.js';
import { ProtocolDecoder } from '../src/Protocol.js';
import { MSG_FULL, MSG_DELTA, MSG_CLIENT_ID, MSG_RECONNECT } from '../src/types.js';
import type { FullStateMessage, DeltaMessage, ClientId } from '../src/types.js';
import WebSocket from 'ws';

// ── Components ──────────────────────────────────────────

const Position = component('HPos', 'f32', ['x', 'y']);
const Health   = component('HHp', 'i32', ['hp', 'maxHp']);
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health,   name: 'Health' },
]);
const decoder = new ProtocolDecoder();

// ── HOL-blocking transport ──────────────────────────────
// Simulates TCP behavior: when a packet is "lost", TCP retransmits
// it, but ALL subsequent packets are held in the kernel buffer
// until the lost one arrives. Then everything is delivered in a
// burst. This wrapper replicates that at the application level.

interface HolTransportOptions {
  /** Delay in ms to simulate TCP retransmission of the blocked packet */
  retransmitDelay: number;
  /** Decide which send() call triggers a HOL block. Return true to "lose" the packet. */
  shouldBlock: (clientId: ClientId, data: ArrayBuffer, callIndex: number) => boolean;
}

function createHolTransport(opts: HolTransportOptions): {
  transport: ServerTransport;
  stats: {
    totalSent: number;
    blockedPackets: number;
    queuedBehind: number;      // packets held up behind a blocked one
    bursts: number;            // times the queue was flushed
    maxBurstSize: number;      // largest burst of packets delivered at once
  };
  /** Manually flush the queue (simulating TCP retransmit completing) */
  flush(): void;
  /** Whether there are queued packets waiting */
  readonly blocked: boolean;
} {
  const inner = createWsTransport();
  const stats = { totalSent: 0, blockedPackets: 0, queuedBehind: 0, bursts: 0, maxBurstSize: 0 };

  // Per-client ordered queue (TCP is per-connection)
  const queues = new Map<ClientId, ArrayBuffer[]>();
  const blockTimers = new Map<ClientId, ReturnType<typeof setTimeout>>();
  let sendCallIndex = 0;
  let isBlocked = false;

  function flushClient(clientId: ClientId) {
    const queue = queues.get(clientId);
    if (!queue || queue.length === 0) return;

    const burstSize = queue.length;
    stats.bursts++;
    if (burstSize > stats.maxBurstSize) stats.maxBurstSize = burstSize;

    for (const data of queue) {
      inner.send(clientId, data);
    }
    queue.length = 0;
    blockTimers.delete(clientId);
    isBlocked = queues.size === 0 || [...queues.values()].every(q => q.length === 0);
  }

  function flushAll() {
    for (const clientId of queues.keys()) {
      const timer = blockTimers.get(clientId);
      if (timer) clearTimeout(timer);
      flushClient(clientId);
    }
  }

  const transport: ServerTransport = {
    async start(port, handlers) {
      return inner.start(port, handlers);
    },

    async stop() {
      for (const timer of blockTimers.values()) clearTimeout(timer);
      blockTimers.clear();
      queues.clear();
      return inner.stop();
    },

    send(clientId, data) {
      const idx = sendCallIndex++;
      const firstByte = new Uint8Array(data)[0];
      stats.totalSent++;

      // Never block MSG_CLIENT_ID or MSG_FULL on first connect
      if (firstByte === MSG_CLIENT_ID || firstByte === MSG_FULL) {
        // But if there's already a queue, these go into it too (TCP is ordered)
        const queue = queues.get(clientId);
        if (queue && queue.length > 0) {
          queue.push(data);
          stats.queuedBehind++;
          return;
        }
        inner.send(clientId, data);
        return;
      }

      // Check if this packet triggers a block
      const queue = queues.get(clientId) ?? [];
      if (!queues.has(clientId)) queues.set(clientId, queue);

      if (queue.length > 0) {
        // Already blocked — queue behind
        queue.push(data);
        stats.queuedBehind++;
        return;
      }

      if (opts.shouldBlock(clientId, data, idx)) {
        // This packet is "lost" — TCP will retransmit after delay
        // Queue it AND all subsequent packets
        stats.blockedPackets++;
        queue.push(data);
        isBlocked = true;

        if (opts.retransmitDelay > 0) {
          const timer = setTimeout(() => flushClient(clientId), opts.retransmitDelay);
          blockTimers.set(clientId, timer);
        }
        return;
      }

      inner.send(clientId, data);
    },

    broadcast(data) {
      inner.broadcast(data);
    },
  };

  return {
    transport,
    stats,
    flush: flushAll,
    get blocked() { return isBlocked; },
  };
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
        const resolve = (buf: ArrayBuffer) => {
          clearTimeout(timer);
          r(buf);
        };
        waiters.push(resolve);
      });
    },
    /** Drain all currently queued messages */
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
  const view = new DataView(idBuf);
  const clientId = view.getUint16(1, true);
  const token = view.getUint32(3, true);
  return { clientId, token, ws, reader };
}

function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Test 1: Basic HOL blocking — one lost packet stalls N ─

it('hol-blocking: one lost TCP packet stalls all subsequent deltas', async () => {
  let blockFirst = true;
  const { transport, stats, flush } = createHolTransport({
    retransmitDelay: 0, // manual flush
    shouldBlock(_cid, _data, _idx) {
      if (blockFirst) { blockFirst = false; return true; }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19980 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19980);
  await reader.recv(); // full state

  // Tick 1: x=10 — this packet gets "lost" (triggers HOL block)
  em.set(e1, Position.x, 10);
  server.tick();

  // Tick 2: x=20 — queued behind the lost packet
  em.set(e1, Position.x, 20);
  server.tick();

  // Tick 3: y=30 — also queued
  em.set(e1, Position.y, 30);
  server.tick();

  // Tick 4: hp component added via Health — also queued
  // (we'll skip this, Position-only is clearer)

  // Nothing should have arrived yet
  await wait(30);
  assert.equal(reader.pending(), 0, 'no messages arrive during HOL block');
  assert.equal(stats.blockedPackets, 1, 'one packet caused the block');
  assert.equal(stats.queuedBehind, 2, 'two packets queued behind it');

  // TCP retransmit completes — everything arrives in a burst
  flush();
  await wait(30);

  // All 3 deltas arrive at once
  assert.equal(reader.pending(), 3, 'all 3 deltas delivered in burst');
  assert.equal(stats.bursts, 1);
  assert.equal(stats.maxBurstSize, 3);

  // Client processes them in order
  const d1 = decoder.decode(await reader.recv(), registry) as DeltaMessage;
  const d2 = decoder.decode(await reader.recv(), registry) as DeltaMessage;
  const d3 = decoder.decode(await reader.recv(), registry) as DeltaMessage;

  // Delta 1: x changed 0→10
  assert.ok(Math.abs((d1.updated[0].data.x as number) - 10) < 0.01);
  // Delta 2: x changed 10→20
  assert.ok(Math.abs((d2.updated[0].data.x as number) - 20) < 0.01);
  // Delta 3: y changed 0→30 (x didn't change in tick 3)
  assert.ok(Math.abs((d3.updated[0].data.y as number) - 30) < 0.01);
  assert.equal(d3.updated[0].data.x, undefined);

  ws.terminate();
  await server.stop();
});

// ── Test 2: Latency spike measurement ───────────────────
// Simulates a 50ms tick rate with a 150ms retransmit delay.
// Shows that the client experiences a gap then a burst.

it('hol-blocking: simulated latency spike — client sees gap then burst', async () => {
  const TICK_INTERVAL = 20; // ms between server ticks
  const RETRANSMIT    = 80; // ms to simulate TCP retransmit

  let blockOnce = true;
  const { transport, stats } = createHolTransport({
    retransmitDelay: RETRANSMIT,
    shouldBlock(_cid, _data, _idx) {
      if (blockOnce) { blockOnce = false; return true; }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19981 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19981);
  await reader.recv(); // full state

  // Record when each message arrives at the client
  const arrivals: number[] = [];
  const origRecv = reader.recv.bind(reader);

  // Run 6 ticks at TICK_INTERVAL spacing
  const t0 = Date.now();
  for (let i = 1; i <= 6; i++) {
    em.set(e1, Position.x, i * 10);
    server.tick();
    await wait(TICK_INTERVAL);
  }

  // Wait for retransmit to complete and everything to arrive
  await wait(RETRANSMIT + 50);

  // Drain all received messages
  const messages = reader.drainAll();

  // With HOL blocking:
  // - Tick 1 packet is "lost" → blocks ticks 2-N
  // - After RETRANSMIT ms, everything flushes at once
  // - Client sees 0 messages for ~RETRANSMIT ms, then a burst

  assert.ok(messages.length >= 4, `expected multiple deltas in burst, got ${messages.length}`);
  assert.equal(stats.blockedPackets, 1, 'one packet was blocked');
  assert.ok(stats.queuedBehind >= 3, `at least 3 packets queued behind (got ${stats.queuedBehind})`);
  assert.equal(stats.bursts, 1, 'one burst when retransmit completed');

  // Decode all — verify they're in order
  let lastX = 0;
  for (const buf of messages) {
    const delta = decoder.decode(buf, registry) as DeltaMessage;
    if (delta.updated.length > 0 && delta.updated[0].data.x !== undefined) {
      const x = delta.updated[0].data.x as number;
      assert.ok(x > lastX, `x values should increase: ${x} > ${lastX}`);
      lastX = x;
    }
  }

  ws.terminate();
  await server.stop();
});

// ── Test 3: Stale data problem ──────────────────────────
// When the burst arrives, the client processes deltas in order.
// But all those intermediate positions are OUTDATED — the entity
// already moved past them. With UDP you'd just take the latest.

it('hol-blocking: burst delivers stale intermediate states that TCP forces you to process', async () => {
  let blockOnce = true;
  const { transport, flush } = createHolTransport({
    retransmitDelay: 0,
    shouldBlock(_cid, _data, _idx) {
      if (blockOnce) { blockOnce = false; return true; }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19982 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19982);
  await reader.recv(); // full state

  // Simulate 5 ticks of movement — all blocked
  const positions = [10, 20, 30, 40, 50];
  for (const x of positions) {
    em.set(e1, Position.x, x);
    server.tick();
  }

  await wait(20);
  assert.equal(reader.pending(), 0, 'all stuck behind HOL block');

  // TCP retransmit completes
  flush();
  await wait(20);

  const messages = reader.drainAll();
  assert.equal(messages.length, 5, 'all 5 deltas arrive at once');

  // With TCP: client MUST process all 5 in order
  // Entity visually teleports: 0 → 10 → 20 → 30 → 40 → 50 in one frame
  // The intermediate values (10, 20, 30, 40) are useless — the entity
  // is already at 50 on the server.
  const xValues: number[] = [];
  for (const buf of messages) {
    const delta = decoder.decode(buf, registry) as DeltaMessage;
    if (delta.updated.length > 0 && delta.updated[0].data.x !== undefined) {
      xValues.push(delta.updated[0].data.x as number);
    }
  }

  assert.deepEqual(xValues.map(v => Math.round(v)), [10, 20, 30, 40, 50]);

  // With UDP: you'd just receive the latest (50) and skip the rest.
  // That's 4 unnecessary decode + apply operations that TCP forces on you.
  const wastedDeltas = xValues.length - 1;
  assert.equal(wastedDeltas, 4, '4 out of 5 deltas are stale/wasted work');

  ws.terminate();
  await server.stop();
});

// ── Test 4: Multi-client independence ───────────────────
// TCP HOL blocking is per-connection. Client A's packet loss
// should NOT affect client B.

it('hol-blocking: per-connection — client A blocked, client B unaffected', async () => {
  let blockClientId = -1;
  let blocked = false;
  const { transport, flush } = createHolTransport({
    retransmitDelay: 0,
    shouldBlock(cid, _data, _idx) {
      if (!blocked && cid === blockClientId) {
        blocked = true;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19983 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  // Connect two clients
  const clientA = await connectNew(19983);
  await clientA.reader.recv(); // full state A
  const clientB = await connectNew(19983);
  await clientB.reader.recv(); // full state B

  // Block only client A's transport connection
  // The transport uses internal IDs, but our shouldBlock uses the transport
  // clientId. We need to figure out which one is A.
  // Since A connected first, its transport ID = 1. Block that.
  blockClientId = 1;

  // Server ticks — updates entity
  em.set(e1, Position.x, 42);
  server.tick();
  await wait(30);

  // Client B should receive the delta immediately
  const bMsg = await clientB.reader.tryRecv(50);
  assert.ok(bMsg !== null, 'client B receives delta normally');
  const bDelta = decoder.decode(bMsg, registry) as DeltaMessage;
  assert.ok(Math.abs((bDelta.updated[0].data.x as number) - 42) < 0.01);

  // Client A is blocked — nothing arrives
  assert.equal(clientA.reader.pending(), 0, 'client A is HOL-blocked');

  // More ticks — B keeps getting them, A keeps queuing
  em.set(e1, Position.y, 99);
  server.tick();
  await wait(30);

  assert.ok(clientB.reader.pending() > 0, 'client B still receives');
  assert.equal(clientA.reader.pending(), 0, 'client A still blocked');

  // Flush A's queue
  flush();
  await wait(30);

  // Now A gets everything in a burst
  assert.ok(clientA.reader.pending() >= 2, 'client A receives burst');

  clientA.ws.terminate();
  clientB.ws.terminate();
  await server.stop();
});

// ── Test 5: Entity create/destroy during HOL block ──────
// Worst case: entity is created AND destroyed while client
// is HOL-blocked. Client receives create followed by destroy
// in the burst — wasted entity allocation.

it('hol-blocking: entity created and destroyed during block = wasted work on client', async () => {
  let blockOnce = true;
  const { transport, flush } = createHolTransport({
    retransmitDelay: 0,
    shouldBlock(_cid, _data, _idx) {
      if (blockOnce) { blockOnce = false; return true; }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19984 }, transport);
  em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19984);
  await reader.recv(); // full state

  // Tick 1: create a temporary entity — BLOCKED
  const temp = em.createEntityWith(Position, { x: 999, y: 999 }, Networked);
  server.tick();

  // Tick 2: destroy it immediately — also queued
  em.destroyEntity(temp);
  server.tick();

  await wait(20);
  assert.equal(reader.pending(), 0, 'both deltas blocked');

  // Flush — client gets create then destroy
  flush();
  await wait(20);

  const messages = reader.drainAll();
  assert.equal(messages.length, 2, 'both deltas arrive in burst');

  const d1 = decoder.decode(messages[0], registry) as DeltaMessage;
  const d2 = decoder.decode(messages[1], registry) as DeltaMessage;

  // Delta 1: entity created
  assert.equal(d1.created.size, 1, 'first delta creates the entity');

  // Delta 2: entity destroyed
  assert.equal(d2.destroyed.length, 1, 'second delta destroys it');

  // With UDP: you could collapse these — never allocate the entity at all.
  // TCP forces you to process both, creating garbage.

  ws.terminate();
  await server.stop();
});
