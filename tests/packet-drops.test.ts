import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked } from '../src/DirtyTracker.js';
import { createNetServer, createWsTransport } from '../src/NetServer.js';
import type { ServerTransport, TransportHandlers } from '../src/NetServer.js';
import { ProtocolDecoder } from '../src/Protocol.js';
import { MSG_FULL, MSG_DELTA, MSG_CLIENT_ID, MSG_RECONNECT, MSG_CLIENT_DELTA } from '../src/types.js';
import type { FullStateMessage, DeltaMessage, ClientId } from '../src/types.js';
import WebSocket from 'ws';

// ── Components ──────────────────────────────────────────

const Position = component('DPos', 'f32', ['x', 'y']);
const Health   = component('DHp', 'i32', ['hp', 'maxHp']);
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health,   name: 'Health' },
]);
const decoder = new ProtocolDecoder();

// ── Lossy transport wrapper ─────────────────────────────
// Wraps the real WS transport and selectively drops messages
// in either direction to simulate packet loss.

interface LossyTransportOptions {
  /** Drop outgoing server→client send() calls. Return true to drop. */
  dropSend?: (clientId: ClientId, data: ArrayBuffer, callIndex: number) => boolean;
  /** Drop incoming client→server messages. Return true to drop. */
  dropRecv?: (clientId: ClientId, data: ArrayBuffer, callIndex: number) => boolean;
}

function createLossyTransport(opts: LossyTransportOptions): {
  transport: ServerTransport;
  stats: { sent: number; dropped_send: number; received: number; dropped_recv: number };
} {
  const inner = createWsTransport();
  const stats = { sent: 0, dropped_send: 0, received: 0, dropped_recv: 0 };
  let sendCallIndex = 0;
  let recvCallIndex = 0;

  const transport: ServerTransport = {
    async start(port, handlers) {
      // Wrap the onMessage handler to intercept incoming
      const wrappedHandlers: TransportHandlers = {
        onOpen: handlers.onOpen,
        onClose: handlers.onClose,
        onMessage(clientId, data) {
          const idx = recvCallIndex++;
          const firstByte = new Uint8Array(data)[0];
          // Never drop handshake messages — they're required for connection setup
          if (firstByte === MSG_RECONNECT) {
            stats.received++;
            handlers.onMessage(clientId, data);
            return;
          }
          if (opts.dropRecv?.(clientId, data, idx)) {
            stats.dropped_recv++;
            return;
          }
          stats.received++;
          handlers.onMessage(clientId, data);
        },
      };
      return inner.start(port, wrappedHandlers);
    },

    async stop() {
      return inner.stop();
    },

    send(clientId, data) {
      const idx = sendCallIndex++;
      const firstByte = new Uint8Array(data)[0];
      // Never drop MSG_CLIENT_ID — connection won't establish without it
      if (firstByte === MSG_CLIENT_ID) {
        stats.sent++;
        inner.send(clientId, data);
        return;
      }
      if (opts.dropSend?.(clientId, data, idx)) {
        stats.dropped_send++;
        return;
      }
      stats.sent++;
      inner.send(clientId, data);
    },

    broadcast(data) {
      // broadcast is not used by NetServer (it sends per-client), but wrap it too
      inner.broadcast(data);
    },
  };

  return { transport, stats };
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
    /** Try to receive within timeout. Returns null if nothing arrives. */
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

// ── Scenario 1: Server→Client dropped deltas ────────────
// When server deltas are dropped, the client misses field
// updates. The next delivered delta should only contain the
// diff since the LAST tick, not accumulated changes.

it('packet-drop: server→client dropped deltas cause stale client state', async () => {
  let dropNext = false;
  const { transport, stats } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_DELTA && dropNext) {
        dropNext = false;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19970 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19970);
  // Full state received — client has x=0, y=0
  const full = decoder.decode(await reader.recv(), registry) as FullStateMessage;
  assert.equal(full.entities.get(1)!.get(0)!.x, 0);

  // Tick 1: move to x=10 — DROP this delta
  dropNext = true;
  em.set(e1, Position.x, 10);
  server.tick();
  const missed = await reader.tryRecv(50);
  assert.equal(missed, null, 'delta should have been dropped');
  assert.equal(stats.dropped_send, 1);

  // Tick 2: move to x=20 — this delta SHOULD be delivered
  em.set(e1, Position.x, 20);
  server.tick();
  const delta2 = decoder.decode(await reader.recv(), registry) as DeltaMessage;

  // Key question: does the client see x=20? Yes, but it never saw x=10.
  // The delta only contains the diff from tick 1→2 (x changed from 10→20).
  // The client correctly gets the latest value.
  assert.equal(delta2.type, MSG_DELTA);
  assert.equal(delta2.updated.length, 1);
  assert.ok(Math.abs((delta2.updated[0].data.x as number) - 20) < 0.01);

  ws.terminate();
  await server.stop();
});

// ── Scenario 2: Dropped delta where field doesn't change after ──
// If x changes to 10 (dropped), then x stays at 10 on next tick,
// the server snapshot won't see a diff and won't re-send x.
// The client is permanently stuck on the old value.

it('packet-drop: missed delta with no subsequent change = permanent desync', async () => {
  let dropCount = 0;
  const { transport } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_DELTA && dropCount < 1) {
        dropCount++;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19971 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19971);
  await reader.recv(); // full state (x=0)

  // Move to x=50 — this delta gets DROPPED
  em.set(e1, Position.x, 50);
  server.tick();
  const missed = await reader.tryRecv(50);
  assert.equal(missed, null, 'delta was dropped');

  // Tick again WITHOUT changing x — no diff, no delta sent
  server.tick();
  const empty = await reader.tryRecv(50);
  assert.equal(empty, null, 'no delta because nothing changed server-side');

  // Client still thinks x=0, server has x=50 → DESYNC
  // Only changing y would send a delta, but x wouldn't be included
  em.set(e1, Position.y, 99);
  server.tick();
  const delta = decoder.decode(await reader.recv(), registry) as DeltaMessage;
  assert.equal(delta.updated[0].data.y, 99);
  assert.equal(delta.updated[0].data.x, undefined, 'x is NOT re-sent — client still desynced on x');

  ws.terminate();
  await server.stop();
});

// ── Scenario 3: Dropped entity creation ─────────────────
// If the delta containing a new entity creation is dropped,
// the client never knows the entity exists.

it('packet-drop: dropped entity creation = client never sees entity', async () => {
  let dropNext = false;
  const { transport } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_DELTA && dropNext) {
        dropNext = false;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19972 }, transport);
  const e1 = em.createEntityWith(Position, { x: 1, y: 1 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19972);
  const full = decoder.decode(await reader.recv(), registry) as FullStateMessage;
  assert.equal(full.entities.size, 1); // e1 only

  // Create e2 — DROP this delta
  dropNext = true;
  em.createEntityWith(Position, { x: 100, y: 200 }, Networked);
  server.tick();
  const missed = await reader.tryRecv(50);
  assert.equal(missed, null);

  // Now update e1 — this delta delivers, but does it include e2 creation?
  em.set(e1, Position.x, 5);
  server.tick();
  const delta = decoder.decode(await reader.recv(), registry) as DeltaMessage;

  // e2's creation was in the PREVIOUS tick's delta. The snapshot already
  // flushed, so e2 won't appear as "created" again.
  assert.equal(delta.created.size, 0, 'e2 creation is NOT re-sent');
  assert.equal(delta.updated.length, 1, 'only e1 update is sent');

  ws.terminate();
  await server.stop();
});

// ── Scenario 4: Dropped entity destruction ──────────────
// If the destroy delta is dropped, the client has a ghost entity.

it('packet-drop: dropped entity destruction = ghost entity on client', async () => {
  let dropNext = false;
  const { transport } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_DELTA && dropNext) {
        dropNext = false;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19973 }, transport);
  const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
  const e2 = em.createEntityWith(Position, { x: 3, y: 4 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19973);
  const full = decoder.decode(await reader.recv(), registry) as FullStateMessage;
  assert.equal(full.entities.size, 2);

  // Destroy e1 — DROP this delta
  dropNext = true;
  em.destroyEntity(e1);
  server.tick();
  const missed = await reader.tryRecv(50);
  assert.equal(missed, null);

  // Update e2 — delta delivers but does NOT re-send destroy for e1
  em.set(e2, Position.x, 99);
  server.tick();
  const delta = decoder.decode(await reader.recv(), registry) as DeltaMessage;

  assert.equal(delta.destroyed.length, 0, 'destroy is NOT re-sent');
  assert.equal(delta.updated.length, 1);
  // Client still has e1 as a ghost entity

  ws.terminate();
  await server.stop();
});

// ── Scenario 5: Client→Server drops (client input lost) ─
// When the client sends a delta that the server never receives,
// the server state doesn't update. The client may have already
// applied the change locally (optimistic), creating a split.

it('packet-drop: client→server dropped delta = server ignores client input', async () => {
  let dropClientDelta = false;
  const { transport, stats } = createLossyTransport({
    dropRecv(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_CLIENT_DELTA && dropClientDelta) {
        dropClientDelta = false;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19974 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19974);
  await reader.recv(); // full state

  // Simulate a client sending a position update that gets dropped
  // We'll craft a MSG_CLIENT_DELTA manually
  dropClientDelta = true;

  // Build a minimal client delta: update netId=1, Position (wireId=0), x=999
  const { ProtocolEncoder } = await import('../src/Protocol.js');
  const enc = new ProtocolEncoder();
  enc.reset();
  enc.writeU8(MSG_CLIENT_DELTA);
  enc.writeU16(1);          // 1 update
  enc.writeVarint(1);       // netId=1
  enc.writeU8(1);           // 1 component
  enc.writeU8(0);           // wireId=0 (Position)
  enc.writeU16(0x01);       // bitmask: field 0 (x)
  enc.writeF32(999);        // x=999
  enc.writeU16(0);          // 0 attached
  enc.writeU16(0);          // 0 detached
  ws.send(Buffer.from(enc.finish()));

  await wait(50);
  assert.equal(stats.dropped_recv, 1, 'client delta was dropped');

  // Server's Position.x should still be 0
  assert.ok(Math.abs(em.get(e1, Position.x)) < 0.01, 'server never applied dropped client delta');

  ws.terminate();
  await server.stop();
});

// ── Scenario 6: Consecutive drops then recovery ─────────
// Drop N deltas in a row, then deliver. Check what state
// the client actually converges to.

it('packet-drop: consecutive server drops then recovery', async () => {
  let dropRemaining = 3;
  const { transport } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_DELTA && dropRemaining > 0) {
        dropRemaining--;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19975 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Health, { hp: 100, maxHp: 100 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19975);
  await reader.recv(); // full state

  // Tick 1: x=10 — DROPPED
  em.set(e1, Position.x, 10);
  server.tick();
  assert.equal(await reader.tryRecv(30), null);

  // Tick 2: x=20, hp=80 — DROPPED
  em.set(e1, Position.x, 20);
  em.set(e1, Health.hp, 80);
  server.tick();
  assert.equal(await reader.tryRecv(30), null);

  // Tick 3: y=50 — DROPPED
  em.set(e1, Position.y, 50);
  server.tick();
  assert.equal(await reader.tryRecv(30), null);

  // Tick 4: hp=60 — DELIVERED (dropRemaining is now 0)
  em.set(e1, Health.hp, 60);
  server.tick();
  const delta = decoder.decode(await reader.recv(), registry) as DeltaMessage;

  // Only the diff from tick 3→4 is sent: hp changed from 80→60
  // x, y are NOT included because they didn't change in tick 4
  assert.equal(delta.type, MSG_DELTA);
  const fields = delta.updated.reduce((acc, u) => {
    for (const [k, v] of Object.entries(u.data)) acc[k] = v;
    return acc;
  }, {} as Record<string, unknown>);

  assert.equal(fields.hp, 60, 'hp is delivered in tick 4');
  assert.equal(fields.x, undefined, 'x NOT included — last changed in tick 2');
  assert.equal(fields.y, undefined, 'y NOT included — last changed in tick 3');

  // RESULT: client has x=0 (desync), y=0 (desync), hp=60 (correct)
  // The delta system has no mechanism to re-send missed field values.

  ws.terminate();
  await server.stop();
});

// ── Scenario 7: Bidirectional drops ─────────────────────
// Both sides lose messages simultaneously.

it('packet-drop: bidirectional drops — both sides lose messages', async () => {
  let dropServerDelta = false;
  let dropClientDelta = false;
  const { transport, stats } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      return type === MSG_DELTA && dropServerDelta;
    },
    dropRecv(_cid, data) {
      const type = new Uint8Array(data)[0];
      return type === MSG_CLIENT_DELTA && dropClientDelta;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19976 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader } = await connectNew(19976);
  await reader.recv(); // full state

  // Both directions drop simultaneously
  dropServerDelta = true;
  dropClientDelta = true;

  // Server moves entity
  em.set(e1, Position.x, 50);
  server.tick();
  assert.equal(await reader.tryRecv(30), null, 'server delta dropped');

  // Client sends position update — also dropped
  const { ProtocolEncoder } = await import('../src/Protocol.js');
  const enc = new ProtocolEncoder();
  enc.reset();
  enc.writeU8(MSG_CLIENT_DELTA);
  enc.writeU16(1);          // 1 update
  enc.writeVarint(1);       // netId=1
  enc.writeU8(1);           // 1 component
  enc.writeU8(0);           // wireId=0 (Position)
  enc.writeU16(0x02);       // bitmask: field 1 (y)
  enc.writeF32(777);        // y=777
  enc.writeU16(0);          // 0 attached
  enc.writeU16(0);          // 0 detached
  ws.send(Buffer.from(enc.finish()));
  await wait(50);

  assert.ok(stats.dropped_send > 0, 'server→client drops occurred');
  assert.ok(stats.dropped_recv > 0, 'client→server drops occurred');

  // Server state: x=50, y=0 (client's y=777 was dropped)
  assert.ok(Math.abs(em.get(e1, Position.x) - 50) < 0.01);
  assert.ok(Math.abs(em.get(e1, Position.y)) < 0.01);

  // Stop dropping
  dropServerDelta = false;
  dropClientDelta = false;

  // Next tick: x didn't change since last tick, so no delta
  server.tick();
  const noMsg = await reader.tryRecv(50);
  assert.equal(noMsg, null, 'no delta — nothing changed since last tick');

  // Make a change to force a delta through
  em.set(e1, Position.y, 42);
  server.tick();
  const delta = decoder.decode(await reader.recv(), registry) as DeltaMessage;
  assert.equal(delta.updated.length, 1);
  assert.ok(Math.abs((delta.updated[0].data.y as number) - 42) < 0.01);
  // Client now has y=42 (correct) but x=0 (still desynced from the dropped x=50)
  assert.equal(delta.updated[0].data.x, undefined, 'x not re-sent');

  ws.terminate();
  await server.stop();
});

// ── Scenario 8: Full state drop on connect ──────────────
// If the initial full state message is dropped, the client
// has no entities at all.

it('packet-drop: dropped full state on connect = empty client', async () => {
  let dropFullState = true;
  const { transport } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_FULL && dropFullState) {
        dropFullState = false;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19977 }, transport);
  em.createEntityWith(Position, { x: 10, y: 20 }, Networked);
  server.tick();
  await server.start();

  const ws = new WebSocket('ws://localhost:19977');
  await new Promise<void>(r => ws.on('open', r));
  const reader = createMessageReader(ws);
  sendHandshake(ws, 0);

  // MSG_CLIENT_ID arrives (never dropped)
  const idBuf = await reader.recv();
  assert.equal(new Uint8Array(idBuf)[0], MSG_CLIENT_ID);

  // Full state was dropped
  const full = await reader.tryRecv(100);
  assert.equal(full, null, 'full state was dropped');

  // Next server tick sends a delta — but client has no baseline
  const e1 = em.getAllEntities()[0];
  em.set(e1, Position.x, 99);
  server.tick();
  const deltaBuf = await reader.recv();
  const delta = decoder.decode(deltaBuf, registry) as DeltaMessage;
  // Delta contains an update for netId=1, but client doesn't have netId=1
  // because it never received the full state.
  assert.equal(delta.type, MSG_DELTA);
  assert.equal(delta.updated.length, 1);
  assert.equal(delta.updated[0].netId, 1);
  // A real client applying this would skip it (unknown netId) → still desynced

  ws.terminate();
  await server.stop();
});

// ── Scenario 9: Recovery via reconnect ──────────────────
// The ONLY current mechanism to recover from desync is to
// disconnect and reconnect, which triggers a full state resend.

it('packet-drop: reconnect is the only way to recover from desync', async () => {
  let dropFirst = true;
  const { transport } = createLossyTransport({
    dropSend(_cid, data) {
      const type = new Uint8Array(data)[0];
      if (type === MSG_DELTA && dropFirst) {
        dropFirst = false;
        return true;
      }
      return false;
    },
  });

  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19978, reconnectWindow: 5000 }, transport);
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { ws, reader, token } = await connectNew(19978);
  await reader.recv(); // full state

  // Drop: x moves to 42 — client never sees it
  em.set(e1, Position.x, 42);
  server.tick();
  assert.equal(await reader.tryRecv(50), null);

  // No more changes → client stuck with x=0 forever (desync)
  server.tick();
  assert.equal(await reader.tryRecv(50), null);

  // Fix: disconnect and reconnect
  ws.terminate();
  await wait(50);

  const ws2 = new WebSocket('ws://localhost:19978');
  await new Promise<void>(r => ws2.on('open', r));
  const reader2 = createMessageReader(ws2);

  const hBuf = Buffer.alloc(5);
  hBuf.writeUint8(MSG_RECONNECT, 0);
  hBuf.writeUint32LE(token, 1);
  ws2.send(hBuf);

  await reader2.recv(); // MSG_CLIENT_ID
  const fullBuf = await reader2.recv(); // full state
  const full = decoder.decode(fullBuf, registry) as FullStateMessage;

  // Full state contains the CURRENT server values — desync resolved
  assert.equal(full.type, MSG_FULL);
  const posData = full.entities.get(1)!.get(0)!;
  assert.ok(Math.abs((posData.x as number) - 42) < 0.01, 'x=42 in full state — desync resolved');

  ws2.terminate();
  await server.stop();
});
