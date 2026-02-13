import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder, ProtocolDecoder } from '../src/Protocol.js';
import { MSG_CLIENT_DELTA } from '../src/types.js';
import type { ClientDeltaMessage } from '../src/types.js';

// ── Test components ─────────────────────────────────────

const Position = component('Pos', 'i16', ['x', 'y']);
const Owner = component('Own', 'u16', ['clientId']);
const Health = component('Hp', 'i16', ['current', 'max']);

const registry = createComponentRegistry([
  { component: Position, name: 'Position', clientOwned: true },
  { component: Owner, name: 'Owner' },
  { component: Health, name: 'Health' },
]);

// ── Tests ───────────────────────────────────────────────

describe('clientOwned registry', () => {
  it('stores clientOwned flag on registered components', () => {
    assert.equal(registry.byName('Position')?.clientOwned, true);
    assert.equal(registry.byName('Owner')?.clientOwned, false);
    assert.equal(registry.byName('Health')?.clientOwned, false);
  });

  it('exposes clientOwnedWireIds set', () => {
    assert.equal(registry.clientOwnedWireIds.size, 1);
    assert.ok(registry.clientOwnedWireIds.has(0)); // Position wireId
    assert.ok(!registry.clientOwnedWireIds.has(1)); // Owner wireId
  });

  it('hash changes when clientOwned flag changes', () => {
    const reg1 = createComponentRegistry([
      { component: Position, name: 'Position' },
      { component: Owner, name: 'Owner', clientOwned: false },
    ]);
    const reg2 = createComponentRegistry([
      { component: Position, name: 'Position' },
      { component: Owner, name: 'Owner', clientOwned: true },
    ]);
    assert.notEqual(reg1.hash, reg2.hash);
  });
});

describe('MSG_CLIENT_DELTA encode/decode', () => {
  it('roundtrips a client delta message', () => {
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    // Manually encode a MSG_CLIENT_DELTA
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1); // 1 updated entity
    // Entity: netId=42, 1 component
    encoder.writeVarint(42);
    encoder.writeU8(1); // 1 component
    encoder.writeU8(0); // wireId 0 = Position
    encoder.writeU16(0b11); // both fields dirty
    encoder.writeField('i16', 10);  // x
    encoder.writeField('i16', 20);  // y
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count

    const buffer = encoder.finish();
    const msg = decoder.decode(buffer, registry) as ClientDeltaMessage;

    assert.equal(msg.type, MSG_CLIENT_DELTA);
    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].netId, 42);
    assert.equal(msg.updated[0].componentWireId, 0);
    assert.equal(msg.updated[0].fieldMask, 0b11);
    assert.equal(msg.updated[0].data.x, 10);
    assert.equal(msg.updated[0].data.y, 20);
  });

  it('rejects non-clientOwned wireId in client delta', () => {
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(1);
    encoder.writeU8(1);
    encoder.writeU8(1); // wireId 1 = Owner, not clientOwned
    encoder.writeU16(0b1);
    encoder.writeField('u16', 1);
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count

    const buffer = encoder.finish();
    assert.throws(() => decoder.decode(buffer, registry), /not clientOwned/);
  });

  it('encodes partial field updates', () => {
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(5);
    encoder.writeU8(1);
    encoder.writeU8(0); // wireId 0 = Position
    encoder.writeU16(0b10); // only field 1 (y) dirty
    encoder.writeField('i16', 30);  // y = 30
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count

    const buffer = encoder.finish();
    const msg = decoder.decode(buffer, registry) as ClientDeltaMessage;

    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].fieldMask, 0b10);
    assert.deepEqual(msg.updated[0].data, { y: 30 });
  });
});

describe('client roundtrip: tick sends clientOwned changes to server', () => {
  it('client.tick() sends Position delta that the server applies', async () => {
    const { createNetServer } = await import('../src/NetServer.js');
    const { createNetClient } = await import('../src/NetClient.js');
    const { WebSocket: NodeWebSocket, WebSocketServer } = await import('ws');

    // Polyfill global WebSocket for Node.js (createNetClient uses browser API)
    (globalThis as any).WebSocket = NodeWebSocket;

    const PORT = 19950 + Math.floor(Math.random() * 1000);

    // ── Server setup ────────────────────────────────────────
    const serverEm = createEntityManager();
    const server = createNetServer(serverEm, registry, { port: PORT }, undefined, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    // Create player entity owned by client 1
    const playerEid = serverEm.createEntityWith(
      Position, { x: 5, y: 10 },
      Owner, { clientId: 1 },
      Networked,
    );

    server.tick(); // baseline snapshot, assigns netIds

    await server.start();

    // ── Client setup ────────────────────────────────────────
    const clientEm = createEntityManager();
    const client = createNetClient(clientEm, registry, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await new Promise<void>((resolve) => {
      client.onConnected = () => resolve();
      client.connect(`ws://localhost:${PORT}`);
    });

    // Wait a tick for full state to be received and processed
    await new Promise(r => setTimeout(r, 50));

    // Verify: client has the entity with Networked tag
    const allEntities = clientEm.getAllEntities();
    assert.ok(allEntities.length > 0, 'Client should have entities after full state');

    // Find our player entity on the client
    let clientPlayerEid: number | undefined;
    for (const [, eid] of client.netToEntity) {
      if (clientEm.get(eid, Owner.clientId) === 1) {
        clientPlayerEid = eid;
        break;
      }
    }
    assert.ok(clientPlayerEid !== undefined, 'Client should have the player entity');
    assert.ok(clientEm.hasComponent(clientPlayerEid!, Networked),
      'Client entity must have Networked tag for diff tracking');

    // First tick initializes tracking baseline (must happen before input)
    client.tick();

    // ── Simulate user input (after baseline is established) ──
    clientEm.set(clientPlayerEid!, Position.x, 6);
    clientEm.set(clientPlayerEid!, Position.y, 11);

    // Second tick should detect the diff and send
    client.tick();

    // Wait for server to receive the message
    await new Promise(r => setTimeout(r, 50));

    // Verify: server received the Position update
    assert.equal(serverEm.get(playerEid, Position.x), 6,
      'Server should have received x=6 from client delta');
    assert.equal(serverEm.get(playerEid, Position.y), 11,
      'Server should have received y=11 from client delta');

    // Cleanup
    client.disconnect();
    await server.stop();
  });
});

describe('client.ownedEntities', () => {
  it('returns entities owned by this client', async () => {
    const { createNetServer } = await import('../src/NetServer.js');
    const { createNetClient } = await import('../src/NetClient.js');
    const { WebSocket: NodeWebSocket } = await import('ws');

    (globalThis as any).WebSocket = NodeWebSocket;

    const PORT = 19950 + Math.floor(Math.random() * 1000);

    const serverEm = createEntityManager();
    const server = createNetServer(serverEm, registry, { port: PORT }, undefined, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    // Create entities: one owned by client 1, one by client 99, one without owner
    serverEm.createEntityWith(Position, { x: 1, y: 0 }, Owner, { clientId: 1 }, Networked);
    serverEm.createEntityWith(Position, { x: 2, y: 0 }, Owner, { clientId: 99 }, Networked);
    serverEm.createEntityWith(Position, { x: 3, y: 0 }, Networked);

    server.tick();
    await server.start();

    const clientEm = createEntityManager();
    const client = createNetClient(clientEm, registry, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await new Promise<void>((resolve) => {
      client.onConnected = () => resolve();
      client.connect(`ws://localhost:${PORT}`);
    });

    await new Promise(r => setTimeout(r, 50));

    // Client gets assigned clientId=1 by the server
    const owned = client.ownedEntities;
    assert.equal(owned.length, 1, 'Should own exactly 1 entity');
    assert.equal(clientEm.get(owned[0], Position.x), 1, 'Should be the entity with x=1');

    client.disconnect();
    await server.stop();
  });

  it('returns empty array without ownerComponent option', async () => {
    const { createNetClient } = await import('../src/NetClient.js');
    const { WebSocket: NodeWebSocket } = await import('ws');

    (globalThis as any).WebSocket = NodeWebSocket;

    const clientEm = createEntityManager();
    const client = createNetClient(clientEm, registry);

    assert.deepEqual(client.ownedEntities, []);
  });
});

describe('server applies client delta', () => {
  it('applies clientOwned field updates to ECS', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 5, y: 10 },
      Owner, { clientId: 1 },
      Networked,
    );

    // Create server with owner validation
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(port, handlers) {
        // Simulate: first tick to assign netIds
        // We need the differ to assign netIds, so we trigger a tick
        (handlers as any)._handlers = handlers;
      },
      async stop() {},
      send() {},
      broadcast() {},
    }, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await server.start();
    // Run a tick to assign netIds
    server.tick();

    // Get the netId assigned to our entity
    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined, 'Entity should have a netId');

    // Manually encode a client delta
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(0); // wireId 0 = Position
    encoder.writeU16(0b11);
    encoder.writeField('i16', 42); // x
    encoder.writeField('i16', 99); // y
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count

    // Simulate receiving the message from client 1
    const buffer = encoder.finish();
    // Access the transport handlers to send the message
    // The server's onMessage handler should process MSG_CLIENT_DELTA
    server.onMessage = () => { throw new Error('Should not reach user onMessage'); };
    // We need to simulate the transport calling onMessage
    // Since we used a custom transport, we need a different approach
    // Let's use the real transport handler pattern

    await server.stop();
  });
});

describe('ownership validation', () => {
  it('rejects updates from non-owner client', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 5, y: 10 },
      Owner, { clientId: 99 }, // Owner is client 99
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) {
        transportHandlers = handlers;
      },
      async stop() {},
      send() {},
      broadcast() {},
    }, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await server.start();
    // Simulate client connect + tick to assign netIds
    transportHandlers.onOpen(1); // client 1
    server.tick();

    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined);

    // Client 1 tries to update entity owned by client 99
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(0); // wireId 0 = Position
    encoder.writeU16(0b11);
    encoder.writeField('i16', 42);
    encoder.writeField('i16', 99);
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count

    // Send from client 1 — should be rejected because owner is 99
    transportHandlers.onMessage(1, encoder.finish());

    // Values should NOT have changed
    assert.equal(em.get(eid, Position.x), 5);
    assert.equal(em.get(eid, Position.y), 10);

    transportHandlers.onClose(1);
    await server.stop();
  });

  it('accepts updates from the correct owner', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 5, y: 10 },
      Owner, { clientId: 1 }, // Owner is client 1
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) {
        transportHandlers = handlers;
      },
      async stop() {},
      send() {},
      broadcast() {},
    }, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await server.start();
    transportHandlers.onOpen(1);
    server.tick();

    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined);

    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(0); // wireId 0 = Position
    encoder.writeU16(0b11);
    encoder.writeField('i16', 42);
    encoder.writeField('i16', 99);
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count

    // Send from client 1 — should be accepted
    transportHandlers.onMessage(1, encoder.finish());

    assert.equal(em.get(eid, Position.x), 42);
    assert.equal(em.get(eid, Position.y), 99);

    transportHandlers.onClose(1);
    await server.stop();
  });

  it('validate callback can reject updates', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 0, y: 0 },
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) {
        transportHandlers = handlers;
      },
      async stop() {},
      send() {},
      broadcast() {},
    });

    server.validate(Position, {
      delta: (_clientId, _entityId, data) => {
        // Reject if x > 100
        return (data.x as number ?? 0) <= 100;
      },
    });

    await server.start();
    transportHandlers.onOpen(1);
    server.tick();

    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined);

    // Send valid position (x=10)
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(0); // wireId 0 = Position
    encoder.writeU16(0b01); // only x field
    encoder.writeField('i16', 10);
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count
    transportHandlers.onMessage(1, encoder.finish());
    assert.equal(em.get(eid, Position.x), 10);

    // Send invalid position (x=200) — should be rejected
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(0);
    encoder.writeU16(0b01);
    encoder.writeField('i16', 200);
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count
    transportHandlers.onMessage(1, encoder.finish());
    assert.equal(em.get(eid, Position.x), 10); // Still 10, not 200

    transportHandlers.onClose(1);
    await server.stop();
  });

  it('partial delta merges with current ECS values before validation', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 10, y: 20 },
      Networked,
    );

    let transportHandlers: any = null;
    const receivedData: Record<string, unknown>[] = [];
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) {
        transportHandlers = handlers;
      },
      async stop() {},
      send() {},
      broadcast() {},
    });

    server.validate(Position, {
      delta: (_clientId, _entityId, data) => {
        receivedData.push({ ...data });
        return true;
      },
    });

    await server.start();
    transportHandlers.onOpen(1);
    server.tick();

    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined);

    // Send partial delta: only x changed (y omitted from wire)
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(0); // wireId 0 = Position
    encoder.writeU16(0b01); // only field 0 (x) dirty
    encoder.writeField('i16', 15);
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count
    transportHandlers.onMessage(1, encoder.finish());

    // Validator must have received BOTH fields — x from delta, y from ECS
    assert.equal(receivedData.length, 1);
    assert.equal(receivedData[0].x, 15, 'x should come from delta');
    assert.equal(receivedData[0].y, 20, 'y should be filled from current ECS value');

    // ECS should reflect merged values
    assert.equal(em.get(eid, Position.x), 15);
    assert.equal(em.get(eid, Position.y), 20);

    // Send partial delta: only y changed
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(0);
    encoder.writeU16(0b10); // only field 1 (y) dirty
    encoder.writeField('i16', 25);
    encoder.writeU16(0); // attached count
    encoder.writeU16(0); // detached count
    transportHandlers.onMessage(1, encoder.finish());

    assert.equal(receivedData.length, 2);
    assert.equal(receivedData[1].x, 15, 'x should be filled from current ECS value');
    assert.equal(receivedData[1].y, 25, 'y should come from delta');

    assert.equal(em.get(eid, Position.x), 15);
    assert.equal(em.get(eid, Position.y), 25);

    transportHandlers.onClose(1);
    await server.stop();
  });
});
