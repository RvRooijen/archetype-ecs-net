import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder, ProtocolDecoder } from '../src/Protocol.js';
import { MSG_DELTA, MSG_CLIENT_DELTA } from '../src/types.js';
import type { DeltaMessage, ClientDeltaMessage } from '../src/types.js';

// ── Test components ─────────────────────────────────────

const Position = component('ADPos', 'f32', ['x', 'y']);
const Health = component('ADHp', 'i16', ['current', 'max']);
const Owner = component('ADOwn', 'u16', ['clientId']);
const Chopping = component('ADChop', 'u8', ['ticks']);

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health, name: 'Health' },
  { component: Owner, name: 'Owner' },
  { component: Chopping, name: 'Chopping', clientOwned: true },
]);

// ── Server-side detection ───────────────────────────────

describe('server-side attach/detach detection', () => {
  it('detects component attach on existing entity', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    // Create entity with Position + Networked
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    differ.diffAndEncode(encoder); // baseline — assigns netId=1

    // Add Health component to existing entity
    em.addComponent(e1, Health, { current: 100, max: 100 });

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.attached.length, 1);
    assert.equal(msg.attached[0].netId, 1);
    assert.equal(msg.attached[0].componentWireId, 1); // Health wireId
    assert.equal(msg.attached[0].data.current, 100);
    assert.equal(msg.attached[0].data.max, 100);
    assert.equal(msg.detached.length, 0);
  });

  it('detects component detach on existing entity', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    // Create entity with Position + Health + Networked
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Health, { current: 50, max: 100 }, Networked);
    differ.diffAndEncode(encoder); // baseline

    // Remove Health component
    em.removeComponent(e1, Health);

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.detached.length, 1);
    assert.equal(msg.detached[0].netId, 1);
    assert.equal(msg.detached[0].componentWireId, 1); // Health wireId
    assert.equal(msg.attached.length, 0);
  });

  it('detects attach via computeChangeset (interest mode)', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);

    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    // Add Health
    em.addComponent(e1, Health, { current: 75, max: 100 });

    const cs2 = differ.computeChangeset();
    differ.flushSnapshots();

    assert.equal(cs2.attached.length, 1);
    assert.equal(cs2.attached[0].netId, cs1.created[0].netId);
    assert.deepEqual([...cs2.attached[0].wireIds], [1]); // Health wireId
    assert.equal(cs2.detached.length, 0);
  });
});

// ── Encode/decode roundtrip ─────────────────────────────

describe('MSG_DELTA attach/detach encode/decode roundtrip', () => {
  it('roundtrips attached section correctly', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 5, y: 10 }, Networked);
    differ.diffAndEncode(encoder); // baseline

    // Add Health
    em.addComponent(e1, Health, { current: 42, max: 99 });

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.type, MSG_DELTA);
    assert.equal(msg.attached.length, 1);
    assert.equal(msg.attached[0].netId, 1);
    assert.equal(msg.attached[0].componentWireId, 1);
    assert.equal(msg.attached[0].data.current, 42);
    assert.equal(msg.attached[0].data.max, 99);
  });

  it('roundtrips detached section correctly', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Health, { current: 10, max: 10 }, Networked);
    differ.diffAndEncode(encoder); // baseline

    em.removeComponent(e1, Health);

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.detached.length, 1);
    assert.equal(msg.detached[0].netId, 1);
    assert.equal(msg.detached[0].componentWireId, 1);
  });

  it('empty attach/detach sections encode and decode correctly', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
    differ.diffAndEncode(encoder); // baseline

    // No changes
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.attached.length, 0);
    assert.equal(msg.detached.length, 0);
    assert.equal(msg.created.size, 0);
    assert.equal(msg.destroyed.length, 0);
    assert.equal(msg.updated.length, 0);
  });
});

// ── Field changes + attach in same tick ─────────────────

describe('field changes + attach/detach same tick', () => {
  it('field change on Position + attach Health in same tick', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
    differ.diffAndEncode(encoder); // baseline

    // Both: change Position.x AND add Health
    em.set(e1, Position.x, 99);
    em.addComponent(e1, Health, { current: 50, max: 100 });

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    // Health should be in attached
    assert.equal(msg.attached.length, 1);
    assert.equal(msg.attached[0].componentWireId, 1);
    assert.equal(msg.attached[0].data.current, 50);

    // Position should be in updated (synthetic dirty with full bitmask since entity moved archetypes)
    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].netId, 1);
    assert.equal(msg.updated[0].componentWireId, 0); // Position wireId
    // x should be 99 (the changed value)
    assert.ok(Math.abs((msg.updated[0].data.x as number) - 99) < 0.001);
    // y should also be present (full bitmask on unchanged component)
    assert.ok(Math.abs((msg.updated[0].data.y as number) - 0) < 0.001);
  });

  it('field change on Health + detach Position in same tick', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 5, y: 10 }, Health, { current: 100, max: 100 }, Networked);
    differ.diffAndEncode(encoder); // baseline

    // Change Health.current AND remove Position
    em.set(e1, Health.current, 75);
    em.removeComponent(e1, Position);

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    // Position should be in detached
    assert.equal(msg.detached.length, 1);
    assert.equal(msg.detached[0].componentWireId, 0); // Position wireId

    // Health should be in updated (synthetic dirty)
    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].componentWireId, 1);
    assert.equal(msg.updated[0].data.current, 75);
    assert.equal(msg.updated[0].data.max, 100);
  });
});

// ── Client-side detection ───────────────────────────────

describe('client-side attach/detach detection (MSG_CLIENT_DELTA)', () => {
  it('client detects clientOwned component attach and encodes MSG_CLIENT_DELTA', () => {
    const em = createEntityManager();

    // Create entity (simulating server full-state apply)
    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Owner, { clientId: 1 }, Networked);

    // Simulate netToEntity mapping
    const netToEntity = new Map<number, number>();
    netToEntity.set(1, e1);

    // Use the differ to produce a baseline
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    // Baseline tick
    differ.diffAndEncode(encoder);

    // Now add clientOwned component Chopping
    em.addComponent(e1, Chopping, { ticks: 5 });

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    // Chopping should appear as attached
    assert.equal(msg.attached.length, 1);
    assert.equal(msg.attached[0].componentWireId, 3); // Chopping wireId
    assert.equal(msg.attached[0].data.ticks, 5);
  });

  it('client detects clientOwned component detach and encodes MSG_CLIENT_DELTA', () => {
    const em = createEntityManager();

    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Chopping, { ticks: 3 }, Networked);

    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    // Remove clientOwned component
    em.removeComponent(e1, Chopping);

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.detached.length, 1);
    assert.equal(msg.detached[0].componentWireId, 3); // Chopping wireId
  });
});

// ── Server applies client attach/detach ─────────────────

describe('server applies client attach/detach', () => {
  it('server applies attached component from client', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 0, y: 0 },
      Owner, { clientId: 1 },
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) { transportHandlers = handlers; },
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

    // Encode a client delta with an attach
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(0); // 0 updated
    // Attached section: 1 entity with 1 component
    encoder.writeU16(1); // 1 attached entity
    encoder.writeVarint(netId);
    encoder.writeU8(1); // 1 component
    encoder.writeU8(3); // wireId 3 = Chopping
    encoder.writeField('u8', 10); // ticks = 10
    // Detached section: empty
    encoder.writeU16(0);

    transportHandlers.onMessage(1, encoder.finish());

    // Verify: entity now has Chopping component
    assert.ok(em.hasComponent(eid, Chopping), 'Entity should have Chopping after attach');
    assert.equal(em.get(eid, Chopping.ticks), 10);

    transportHandlers.onClose(1);
    await server.stop();
  });

  it('server applies detached component from client', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 0, y: 0 },
      Owner, { clientId: 1 },
      Chopping, { ticks: 5 },
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) { transportHandlers = handlers; },
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

    // Encode a client delta with a detach
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(0); // 0 updated
    // Attached section: empty
    encoder.writeU16(0);
    // Detached section: 1 entity with 1 component
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1); // 1 component
    encoder.writeU8(3); // wireId 3 = Chopping

    transportHandlers.onMessage(1, encoder.finish());

    // Verify: entity no longer has Chopping
    assert.ok(!em.hasComponent(eid, Chopping), 'Entity should not have Chopping after detach');

    transportHandlers.onClose(1);
    await server.stop();
  });
});

// ── Ownership validation for attach/detach ──────────────

describe('ownership validation for attach/detach', () => {
  it('rejects attach from non-owner client', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 0, y: 0 },
      Owner, { clientId: 99 }, // owner is client 99
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) { transportHandlers = handlers; },
      async stop() {},
      send() {},
      broadcast() {},
    }, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await server.start();
    transportHandlers.onOpen(1); // client 1
    server.tick();

    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined);

    // Client 1 tries to attach Chopping to entity owned by client 99
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(0);
    encoder.writeU16(1); // 1 attached entity
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(3); // Chopping
    encoder.writeField('u8', 5);
    encoder.writeU16(0); // 0 detached

    transportHandlers.onMessage(1, encoder.finish());

    // Should be rejected
    assert.ok(!em.hasComponent(eid, Chopping), 'Attach from non-owner should be rejected');

    transportHandlers.onClose(1);
    await server.stop();
  });

  it('rejects detach from non-owner client', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 0, y: 0 },
      Owner, { clientId: 99 },
      Chopping, { ticks: 5 },
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) { transportHandlers = handlers; },
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

    // Client 1 tries to detach Chopping from entity owned by client 99
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(0);
    encoder.writeU16(0); // 0 attached
    encoder.writeU16(1); // 1 detached entity
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(3); // Chopping

    transportHandlers.onMessage(1, encoder.finish());

    // Should still have Chopping
    assert.ok(em.hasComponent(eid, Chopping), 'Detach from non-owner should be rejected');

    transportHandlers.onClose(1);
    await server.stop();
  });

  it('validate attach callback can reject attach', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 0, y: 0 },
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) { transportHandlers = handlers; },
      async stop() {},
      send() {},
      broadcast() {},
    });

    server.validate(Chopping, {
      attach: (_clientId, _entityId, data) => {
        // Only allow Chopping if ticks <= 10
        return (data.ticks as number) <= 10;
      },
    });

    await server.start();
    transportHandlers.onOpen(1);
    server.tick();

    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined);

    // Attach with ticks=5 → should be accepted
    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(0);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(3);
    encoder.writeField('u8', 5);
    encoder.writeU16(0);
    transportHandlers.onMessage(1, encoder.finish());

    assert.ok(em.hasComponent(eid, Chopping), 'Valid attach should be accepted');
    assert.equal(em.get(eid, Chopping.ticks), 5);

    // Remove it to test rejection
    em.removeComponent(eid, Chopping);

    // Attach with ticks=50 → should be rejected
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(0);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(3);
    encoder.writeField('u8', 50);
    encoder.writeU16(0);
    transportHandlers.onMessage(1, encoder.finish());

    assert.ok(!em.hasComponent(eid, Chopping), 'Invalid attach should be rejected');

    transportHandlers.onClose(1);
    await server.stop();
  });

  it('validate detach callback can reject detach', async () => {
    const { createNetServer } = await import('../src/NetServer.js');

    const em = createEntityManager();
    const eid = em.createEntityWith(
      Position, { x: 0, y: 0 },
      Chopping, { ticks: 3 },
      Networked,
    );

    let transportHandlers: any = null;
    const server = createNetServer(em, registry, { port: 0 }, {
      async start(_port, handlers) { transportHandlers = handlers; },
      async stop() {},
      send() {},
      broadcast() {},
    });

    server.validate(Chopping, {
      detach: () => false, // reject all detaches
    });

    await server.start();
    transportHandlers.onOpen(1);
    server.tick();

    const netId = server.entityNetIds.get(eid);
    assert.ok(netId !== undefined);

    const encoder = new ProtocolEncoder();
    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    encoder.writeU16(0);
    encoder.writeU16(0);
    encoder.writeU16(1);
    encoder.writeVarint(netId);
    encoder.writeU8(1);
    encoder.writeU8(3);
    transportHandlers.onMessage(1, encoder.finish());

    // Should still have Chopping (detach rejected)
    assert.ok(em.hasComponent(eid, Chopping), 'Detach should be rejected by validator');

    transportHandlers.onClose(1);
    await server.stop();
  });
});

// ── Interest management path ────────────────────────────

describe('attach/detach with interest management', () => {
  it('preEncodeChangeset + composeFromCache includes attach/detach', async () => {
    const { createClientView } = await import('../src/InterestManager.js');

    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const netId = cs1.created[0].netId;
    const view = createClientView();
    view.update(new Set([netId]), cs1);

    // Add Health
    em.addComponent(e1, Health, { current: 42, max: 100 });

    const cs2 = differ.computeChangeset();

    // Client delta should include attached
    const delta = view.update(new Set([netId]), cs2);
    assert.equal(delta.attached.length, 1);
    assert.equal(delta.attached[0], netId);

    // Encode/decode roundtrip via cache
    const cache = differ.preEncodeChangeset(encoder, cs2, []);
    const buffer = differ.composeFromCache(encoder, cache, delta);
    differ.flushSnapshots();

    const msg = decoder.decode(buffer, registry) as DeltaMessage;
    assert.equal(msg.attached.length, 1);
    assert.equal(msg.attached[0].componentWireId, 1); // Health
    assert.equal(msg.attached[0].data.current, 42);
  });
});
