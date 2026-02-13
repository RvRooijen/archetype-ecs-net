import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked } from '../src/DirtyTracker.js';
import { createNetServer } from '../src/NetServer.js';
import { ProtocolDecoder } from '../src/Protocol.js';
import { MSG_FULL, MSG_DELTA, MSG_CLIENT_ID, MSG_RECONNECT } from '../src/types.js';
import type { FullStateMessage, DeltaMessage } from '../src/types.js';
import WebSocket from 'ws';

const Position = component('RPos', 'f32', ['x', 'y']);
const Health = component('RHp', 'i32', ['hp', 'maxHp']);
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health, name: 'Health' },
]);
const decoder = new ProtocolDecoder();

// ── Helpers ──────────────────────────────────────────────

/** Buffered message reader — pre-buffers all incoming messages so none are lost */
function createMessageReader(ws: WebSocket) {
  const queue: ArrayBuffer[] = [];
  const waiters: ((buf: ArrayBuffer) => void)[] = [];

  ws.on('message', (d: Buffer) => {
    const buf = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(buf);
    } else {
      queue.push(buf);
    }
  });

  return {
    recv(): Promise<ArrayBuffer> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(r => waiters.push(r));
    },
  };
}

/** Send reconnect handshake (token=0 for new client) */
function sendHandshake(ws: WebSocket, token = 0) {
  const buf = Buffer.alloc(5);
  buf.writeUint8(MSG_RECONNECT, 0);
  buf.writeUint32LE(token, 1);
  ws.send(buf);
}

/** Connect, send handshake, receive MSG_CLIENT_ID + full state, return { clientId, token, ws, reader } */
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
  await reader.recv(); // full state
  return { clientId, token, ws, reader };
}

/** Reconnect with a token, return { clientId, token, ws, reader } */
async function connectWithToken(port: number, oldToken: number) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>(r => ws.on('open', r));
  const reader = createMessageReader(ws);
  sendHandshake(ws, oldToken);

  const idBuf = await reader.recv();
  assert.equal(new Uint8Array(idBuf)[0], MSG_CLIENT_ID);
  const view = new DataView(idBuf);
  const clientId = view.getUint16(1, true);
  const token = view.getUint32(3, true);
  await reader.recv(); // full state
  return { clientId, token, ws, reader };
}

function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Tests ────────────────────────────────────────────────

it('reconnect: new client receives MSG_CLIENT_ID with token', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19950, reconnectWindow: 5000 });
  em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
  server.tick();
  await server.start();

  const { clientId, token, ws } = await connectNew(19950);

  assert.ok(clientId > 0, 'clientId should be assigned');
  assert.ok(token !== 0, 'token should be non-zero');
  assert.equal(server.clientCount, 1);

  ws.terminate();
  await server.stop();
});

it('reconnect: client gets same clientId after disconnect + reconnect', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19951, reconnectWindow: 5000 });
  em.createEntityWith(Position, { x: 10, y: 20 }, Networked);
  server.tick();
  await server.start();

  // Connect first time
  const { clientId: firstId, token, ws: ws1 } = await connectNew(19951);

  // Disconnect
  ws1.terminate();
  await wait(100); // Let server process close

  assert.equal(server.clientCount, 0, 'server sees 0 active clients after disconnect');

  // Reconnect with token
  const { clientId: secondId, ws: ws2 } = await connectWithToken(19951, token);

  assert.equal(secondId, firstId, 'clientId should be preserved across reconnect');
  assert.equal(server.clientCount, 1);

  ws2.terminate();
  await server.stop();
});

it('reconnect: onReconnect callback fires on reconnect, not onConnect', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19952, reconnectWindow: 5000 });
  server.tick();
  await server.start();

  const events: string[] = [];
  server.onConnect = (id) => events.push(`connect:${id}`);
  server.onReconnect = (id) => events.push(`reconnect:${id}`);
  server.onDisconnect = (id) => events.push(`disconnect:${id}`);

  const { clientId, token, ws: ws1 } = await connectNew(19952);
  assert.deepEqual(events, [`connect:${clientId}`]);

  ws1.terminate();
  await wait(100);
  // onDisconnect should NOT fire yet (within grace period)
  assert.deepEqual(events, [`connect:${clientId}`]);

  const { ws: ws2 } = await connectWithToken(19952, token);
  assert.deepEqual(events, [`connect:${clientId}`, `reconnect:${clientId}`]);

  ws2.terminate();
  await server.stop();
});

it('reconnect: onDisconnect fires after grace period expires', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19953, reconnectWindow: 200 });
  server.tick();
  await server.start();

  const events: string[] = [];
  server.onConnect = (id) => events.push(`connect:${id}`);
  server.onDisconnect = (id) => events.push(`disconnect:${id}`);

  const { clientId, ws } = await connectNew(19953);

  ws.terminate();
  await wait(100); // Still within grace period
  assert.deepEqual(events, [`connect:${clientId}`]);

  await wait(200); // Grace period expired
  assert.deepEqual(events, [`connect:${clientId}`, `disconnect:${clientId}`]);

  await server.stop();
});

it('reconnect: expired token treated as new client', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19954, reconnectWindow: 100 });
  server.tick();
  await server.start();

  const { clientId: firstId, token, ws: ws1 } = await connectNew(19954);

  ws1.terminate();
  await wait(250); // Wait for grace period to expire

  // Try to reconnect with expired token → should get new clientId
  const { clientId: secondId, ws: ws2 } = await connectWithToken(19954, token);

  assert.notEqual(secondId, firstId, 'expired token should result in new clientId');

  ws2.terminate();
  await server.stop();
});

it('reconnect: reconnectWindow=0 disables reconnect', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19955, reconnectWindow: 0 });
  server.tick();
  await server.start();

  const events: string[] = [];
  server.onDisconnect = (id) => events.push(`disconnect:${id}`);

  const { clientId, token, ws: ws1 } = await connectNew(19955);

  ws1.terminate();
  await wait(100);
  // With reconnectWindow=0, onDisconnect fires immediately
  assert.deepEqual(events, [`disconnect:${clientId}`]);

  // Token should not work
  const { clientId: secondId, ws: ws2 } = await connectWithToken(19955, token);
  assert.notEqual(secondId, clientId, 'reconnect should not work with reconnectWindow=0');

  ws2.terminate();
  await server.stop();
});

it('reconnect: multiple reconnects in sequence', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19956, reconnectWindow: 5000 });
  em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
  server.tick();
  await server.start();

  // First connect
  const { clientId, token: token1, ws: ws1 } = await connectNew(19956);

  // Disconnect + reconnect 1
  ws1.terminate();
  await wait(50);
  const { clientId: id2, token: token2, ws: ws2 } = await connectWithToken(19956, token1);
  assert.equal(id2, clientId);
  assert.notEqual(token2, token1, 'new token should be issued on reconnect');

  // Disconnect + reconnect 2 (using the NEW token, not the old one)
  ws2.terminate();
  await wait(50);
  const { clientId: id3, token: token3, ws: ws3 } = await connectWithToken(19956, token2);
  assert.equal(id3, clientId);
  assert.notEqual(token3, token2);

  // Old token1 should NOT work anymore
  ws3.terminate();
  await wait(50);
  const { clientId: id4, ws: ws4 } = await connectWithToken(19956, token1);
  assert.notEqual(id4, clientId, 'old token should be invalidated after reconnect');

  ws4.terminate();
  await server.stop();
});

it('reconnect: full state received on reconnect contains current entities', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19957, reconnectWindow: 5000 });
  const e1 = em.createEntityWith(Position, { x: 10, y: 20 }, Networked);
  server.tick();
  await server.start();

  // Connect
  const { token: reconnToken, ws: ws1, reader: reader1 } = await connectNew(19957);

  // Mutate entity while connected
  em.set(e1, Position.x, 99);
  server.tick();
  await wait(50);

  // Create another entity
  em.createEntityWith(Health, { hp: 50, maxHp: 50 }, Networked);
  server.tick();

  // Disconnect
  ws1.terminate();
  await wait(50);

  // Reconnect — should get full state with current world (2 entities, updated Position)
  const ws2 = new WebSocket('ws://localhost:19957');
  await new Promise<void>(r => ws2.on('open', r));
  const reader2 = createMessageReader(ws2);
  sendHandshake(ws2, reconnToken);
  await reader2.recv(); // MSG_CLIENT_ID
  const fullBuf = await reader2.recv(); // full state
  const full = decoder.decode(fullBuf, registry) as FullStateMessage;

  assert.equal(full.type, MSG_FULL);
  assert.equal(full.entities.size, 2, 'full state should have 2 entities');

  ws2.terminate();
  await server.stop();
});

it('reconnect: deltas resume after reconnect', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19958, reconnectWindow: 5000 });
  const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
  server.tick();
  await server.start();

  const { token, ws: ws1 } = await connectNew(19958);

  // Disconnect
  ws1.terminate();
  await wait(50);

  // Reconnect
  const ws2 = new WebSocket('ws://localhost:19958');
  await new Promise<void>(r => ws2.on('open', r));
  const reader2 = createMessageReader(ws2);
  sendHandshake(ws2, token);
  await reader2.recv(); // MSG_CLIENT_ID
  await reader2.recv(); // full state

  // Now mutate and tick — client should receive delta
  em.set(e1, Position.x, 42);
  const p = reader2.recv();
  server.tick();
  const deltaBuf = await p;
  const delta = decoder.decode(deltaBuf, registry) as DeltaMessage;

  assert.equal(delta.type, MSG_DELTA);
  assert.equal(delta.updated.length, 1);
  assert.ok(Math.abs((delta.updated[0].data.x as number) - 42) < 0.01);

  ws2.terminate();
  await server.stop();
});
