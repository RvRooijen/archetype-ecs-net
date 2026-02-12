import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked, createSnapshotDiffer } from '../src/DirtyTracker.js';
import { createClientView } from '../src/InterestManager.js';
import { ProtocolEncoder, ProtocolDecoder } from '../src/Protocol.js';
import { createNetServer } from '../src/NetServer.js';
import { MSG_DELTA } from '../src/types.js';
import type { DeltaMessage, FullStateMessage } from '../src/types.js';
import WebSocket from 'ws';

const Position = component('IMPos', 'f32', ['x', 'y']);
const Health = component('IMHp', 'i32', ['hp']);
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health, name: 'Health' },
]);

// ── Unit tests: ClientView ─────────────────────────────────

describe('ClientView', () => {
  function setupDiffer() {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    return { em, differ, encoder };
  }

  it('entity enters view → enters list', () => {
    const { em, differ } = setupDiffer();
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const changeset = differ.computeChangeset();
    differ.flushSnapshots();

    const view = createClientView();
    const interest = new Set([changeset.created[0].netId]);
    const delta = view.update(interest, changeset);

    assert.equal(delta.enters.length, 1);
    assert.equal(delta.enters[0], changeset.created[0].netId);
    assert.equal(delta.leaves.length, 0);
    assert.equal(delta.updates.length, 0);
  });

  it('entity leaves view → leaves list', () => {
    const { em, differ } = setupDiffer();
    em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const netId = cs1.created[0].netId;
    const view = createClientView();

    // Tick 1: entity enters
    view.update(new Set([netId]), cs1);

    // Tick 2: no changes, entity removed from interest
    const cs2 = differ.computeChangeset();
    differ.flushSnapshots();
    const delta = view.update(new Set<number>(), cs2);

    assert.equal(delta.leaves.length, 1);
    assert.equal(delta.leaves[0], netId);
    assert.equal(delta.enters.length, 0);
  });

  it('dirty entity in view → updates list', () => {
    const { em, differ } = setupDiffer();
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const netId = cs1.created[0].netId;
    const view = createClientView();
    view.update(new Set([netId]), cs1);

    // Tick 2: change field
    em.set(e1, Position.x, 99);
    const cs2 = differ.computeChangeset();
    differ.flushSnapshots();

    const delta = view.update(new Set([netId]), cs2);

    assert.equal(delta.updates.length, 1);
    assert.equal(delta.updates[0], netId);
    assert.equal(delta.enters.length, 0);
    assert.equal(delta.leaves.length, 0);
  });

  it('dirty entity out of view → not sent', () => {
    const { em, differ } = setupDiffer();
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const netId = cs1.created[0].netId;
    const view = createClientView();
    // Entity is NOT in client's interest
    view.update(new Set<number>(), cs1);

    // Tick 2: change field but entity not in view
    em.set(e1, Position.x, 99);
    const cs2 = differ.computeChangeset();
    differ.flushSnapshots();

    const delta = view.update(new Set<number>(), cs2);
    assert.equal(delta.updates.length, 0);
    assert.equal(delta.enters.length, 0);
    assert.equal(delta.leaves.length, 0);
  });

  it('globally created entity not in interest → not sent', () => {
    const { em, differ } = setupDiffer();
    em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const changeset = differ.computeChangeset();
    differ.flushSnapshots();

    const view = createClientView();
    const delta = view.update(new Set<number>(), changeset);

    assert.equal(delta.enters.length, 0);
    assert.equal(delta.leaves.length, 0);
  });

  it('globally destroyed entity known to client → leaves', () => {
    const { em, differ } = setupDiffer();
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const netId = cs1.created[0].netId;
    const view = createClientView();
    view.update(new Set([netId]), cs1);

    // Tick 2: destroy entity
    em.destroyEntity(e1);
    const cs2 = differ.computeChangeset();
    differ.flushSnapshots();

    const delta = view.update(new Set<number>(), cs2);
    assert.equal(delta.leaves.length, 1);
    assert.equal(delta.leaves[0], netId);
  });

  it('existing entity enters interest (not globally created) → enters', () => {
    const { em, differ } = setupDiffer();
    em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const netId = cs1.created[0].netId;
    const view = createClientView();

    // Tick 1: entity exists globally but not in client interest
    view.update(new Set<number>(), cs1);

    // Tick 2: entity now enters client interest (no global changes)
    const cs2 = differ.computeChangeset();
    differ.flushSnapshots();
    const delta = view.update(new Set([netId]), cs2);

    assert.equal(delta.enters.length, 1);
    assert.equal(delta.enters[0], netId);
  });
});

// ── Unit tests: composeFromCache ───────────────────────────

describe('composeFromCache', () => {
  it('encodes enters, leaves, and updates correctly', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 5, y: 10 }, Health, { hp: 42 }, Networked);
    const e2 = em.createEntityWith(Position, { x: 20, y: 30 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const view = createClientView();
    const n1 = cs1.created[0].netId;
    const n2 = cs1.created[1].netId;
    view.update(new Set([n1, n2]), cs1);

    // Tick 2: update e1, destroy e2, create e3
    em.set(e1, Position.x, 99);
    em.destroyEntity(e2);
    const e3 = em.createEntityWith(Position, { x: 7, y: 8 }, Networked);

    const cs2 = differ.computeChangeset();
    const n3 = cs2.created[0].netId;
    const delta = view.update(new Set([n1, n3]), cs2);

    const cache = differ.preEncodeChangeset(encoder, cs2, []);
    const buf = differ.composeFromCache(encoder, cache, delta);
    differ.flushSnapshots();

    const msg = decoder.decode(buf, registry) as DeltaMessage;
    // e3 enters with full data
    assert.equal(msg.created.size, 1);
    assert.ok(msg.created.has(n3));
    const posData = msg.created.get(n3)!.get(0)!;
    assert.ok(Math.abs((posData.x as number) - 7) < 0.01);
    assert.ok(Math.abs((posData.y as number) - 8) < 0.01);
    // e2 leaves
    assert.equal(msg.destroyed.length, 1);
    assert.equal(msg.destroyed[0], n2);
    // e1 updated (only x changed)
    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].netId, n1);
    assert.ok(Math.abs((msg.updated[0].data.x as number) - 99) < 0.01);
    assert.equal(msg.updated[0].data.y, undefined);
  });

  it('handles view-enter for existing entities (extraEnterNetIds)', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    em.createEntityWith(Position, { x: 42, y: 7 }, Health, { hp: 10 }, Networked);
    const cs1 = differ.computeChangeset();
    differ.flushSnapshots();

    const netId = cs1.created[0].netId;
    const view = createClientView();
    // Entity exists but client doesn't see it yet
    view.update(new Set<number>(), cs1);

    // Tick 2: no global changes, entity enters client view
    const cs2 = differ.computeChangeset();
    const delta = view.update(new Set([netId]), cs2);

    assert.equal(delta.enters.length, 1);

    // Pre-encode with extraEnterNetIds
    const cache = differ.preEncodeChangeset(encoder, cs2, [netId]);
    const buf = differ.composeFromCache(encoder, cache, delta);
    differ.flushSnapshots();

    const msg = decoder.decode(buf, registry) as DeltaMessage;
    assert.equal(msg.created.size, 1);
    const posData = msg.created.get(netId)!.get(0)!;
    assert.ok(Math.abs((posData.x as number) - 42) < 0.01);
    const hpData = msg.created.get(netId)!.get(1)!;
    assert.equal(hpData.hp, 10);
  });
});

// ── Integration: tick(filter) over WebSocket ───────────────

describe('tick(filter)', () => {
  function recv(ws: WebSocket): Promise<ArrayBuffer> {
    return new Promise(r => ws.once('message', (d: Buffer) =>
      r(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))));
  }

  it('sends filtered deltas per client', async () => {
    const em = createEntityManager();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 10, y: 20 }, Networked);
    const e2 = em.createEntityWith(Position, { x: 30, y: 40 }, Networked);

    const server = createNetServer(em, registry, { port: 19930 });

    // Baseline tick to establish snapshot + assign netIds
    server.tick(() => new Set<number>());

    await server.start();

    // Connect two clients
    const ws1 = new WebSocket('ws://localhost:19930');
    const full1 = decoder.decode(await recv(ws1), registry) as FullStateMessage;
    assert.equal(full1.entities.size, 2);

    const ws2 = new WebSocket('ws://localhost:19930');
    const full2 = decoder.decode(await recv(ws2), registry) as FullStateMessage;
    assert.equal(full2.entities.size, 2);

    // Get netIds from full state
    const netIds = [...full1.entities.keys()];

    // Update both positions
    em.set(e1, Position.x, 99);
    em.set(e2, Position.x, 88);

    const p1 = recv(ws1);
    const p2 = recv(ws2);

    // Client 1 sees only entity 1, client 2 sees only entity 2
    let client1Id: number | null = null;
    let client2Id: number | null = null;

    server.tick((clientId) => {
      // First client connected gets client1Id
      if (client1Id === null) {
        client1Id = clientId;
        return new Set(netIds); // client 1 sees all (already known → updates only)
      }
      if (client2Id === null) client2Id = clientId;
      if (clientId === client1Id) return new Set(netIds);
      // Client 2 sees only entity 2
      return new Set([netIds[1]]);
    });

    // Client 1 should get updates for both entities
    const msg1 = decoder.decode(await p1, registry) as DeltaMessage;
    assert.equal(msg1.updated.length, 2);

    // Client 2 should get update for entity 2 + leave for entity 1
    const msg2 = decoder.decode(await p2, registry) as DeltaMessage;
    // Entity 1 leaves view → destroyed
    assert.equal(msg2.destroyed.length, 1);
    assert.equal(msg2.destroyed[0], netIds[0]);
    // Entity 2 still in view → updated
    assert.equal(msg2.updated.length, 1);
    assert.equal(msg2.updated[0].netId, netIds[1]);
    assert.ok(Math.abs((msg2.updated[0].data.x as number) - 88) < 0.01);

    ws1.terminate();
    ws2.terminate();
    await server.stop();
  });

  it('broadcast tick() still works unchanged', async () => {
    const em = createEntityManager();
    const decoder = new ProtocolDecoder();

    em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const server = createNetServer(em, registry, { port: 19931 });
    server.tick(); // baseline

    await server.start();
    const ws = new WebSocket('ws://localhost:19931');
    const full = decoder.decode(await recv(ws), registry) as FullStateMessage;
    assert.equal(full.entities.size, 1);

    ws.terminate();
    await server.stop();
  });

  it('3 clients with disjoint, overlapping, and shifting filters across multiple ticks', async () => {
    const em = createEntityManager();
    const decoder = new ProtocolDecoder();

    // 4 entities: A, B, C, D
    const eA = em.createEntityWith(Position, { x: 0, y: 0 }, Health, { hp: 100 }, Networked);
    const eB = em.createEntityWith(Position, { x: 10, y: 0 }, Networked);
    const eC = em.createEntityWith(Position, { x: 20, y: 0 }, Networked);
    const eD = em.createEntityWith(Position, { x: 30, y: 0 }, Networked);

    const server = createNetServer(em, registry, { port: 19932 });
    // Baseline — assigns netIds, no clients yet
    server.tick(() => new Set<number>());

    await server.start();

    // Connect 3 clients, capture their clientIds in order
    const clientMap = new Map<number, WebSocket>();
    const orderedIds: number[] = [];

    const origOnConnect = server.onConnect;
    server.onConnect = (cid) => {
      orderedIds.push(cid);
      origOnConnect?.(cid);
    };

    const ws1 = new WebSocket('ws://localhost:19932');
    const full1 = decoder.decode(await recv(ws1), registry) as FullStateMessage;
    // Wait for onConnect to fire
    await new Promise(r => setTimeout(r, 20));

    const ws2 = new WebSocket('ws://localhost:19932');
    const full2 = decoder.decode(await recv(ws2), registry) as FullStateMessage;
    await new Promise(r => setTimeout(r, 20));

    const ws3 = new WebSocket('ws://localhost:19932');
    const full3 = decoder.decode(await recv(ws3), registry) as FullStateMessage;
    await new Promise(r => setTimeout(r, 20));

    // All 3 get full state with 4 entities
    assert.equal(full1.entities.size, 4);
    assert.equal(full2.entities.size, 4);
    assert.equal(full3.entities.size, 4);

    const [nA, nB, nC, nD] = [...full1.entities.keys()].sort((a, b) => a - b);
    const [cid1, cid2, cid3] = orderedIds;
    clientMap.set(cid1, ws1);
    clientMap.set(cid2, ws2);
    clientMap.set(cid3, ws3);

    // ── Tick 1: disjoint filters, entity A updated ──────────
    // Client 1 sees {A, B}, Client 2 sees {C, D}, Client 3 sees {B, C}
    em.set(eA, Position.x, 5);
    em.set(eC, Position.x, 25);

    const p1t1 = recv(ws1);
    const p2t1 = recv(ws2);
    const p3t1 = recv(ws3);

    server.tick((cid) => {
      if (cid === cid1) return new Set([nA, nB]);
      if (cid === cid2) return new Set([nC, nD]);
      return new Set([nB, nC]);
    });

    const m1t1 = decoder.decode(await p1t1, registry) as DeltaMessage;
    // Client 1: sees A (update x=5), C+D leave view
    assert.equal(m1t1.updated.length, 1);
    assert.equal(m1t1.updated[0].netId, nA);
    assert.ok(Math.abs((m1t1.updated[0].data.x as number) - 5) < 0.01);
    assert.equal(m1t1.destroyed.length, 2); // C and D leave
    const leaves1 = m1t1.destroyed.sort((a, b) => a - b);
    assert.deepEqual(leaves1, [nC, nD]);

    const m2t1 = decoder.decode(await p2t1, registry) as DeltaMessage;
    // Client 2: sees C (update x=25), A+B leave view
    assert.equal(m2t1.updated.length, 1);
    assert.equal(m2t1.updated[0].netId, nC);
    assert.ok(Math.abs((m2t1.updated[0].data.x as number) - 25) < 0.01);
    assert.equal(m2t1.destroyed.length, 2); // A and B leave
    const leaves2 = m2t1.destroyed.sort((a, b) => a - b);
    assert.deepEqual(leaves2, [nA, nB]);

    const m3t1 = decoder.decode(await p3t1, registry) as DeltaMessage;
    // Client 3: sees C (update x=25), A+D leave view
    assert.equal(m3t1.updated.length, 1);
    assert.equal(m3t1.updated[0].netId, nC);
    assert.equal(m3t1.destroyed.length, 2); // A and D leave
    const leaves3 = m3t1.destroyed.sort((a, b) => a - b);
    assert.deepEqual(leaves3, [nA, nD]);

    // ── Tick 2: overlapping shift — client 1 gains C, client 3 gains D ──
    // Client 2's filter is unchanged and no entities in {C,D} are dirty → empty delta, no message
    em.set(eB, Position.y, 7);

    const p1t2 = recv(ws1);
    const p3t2 = recv(ws3);

    server.tick((cid) => {
      if (cid === cid1) return new Set([nA, nB, nC]); // +C
      if (cid === cid2) return new Set([nC, nD]);       // unchanged, nothing dirty
      return new Set([nB, nC, nD]);                      // +D
    });

    const m1t2 = decoder.decode(await p1t2, registry) as DeltaMessage;
    // Client 1: B updated (y=7), C enters (full data)
    assert.equal(m1t2.created.size, 1); // C enters
    assert.ok(m1t2.created.has(nC));
    // C should have Position data with x=25 (from tick 1 update)
    const cPosData = m1t2.created.get(nC)!.get(0)!;
    assert.ok(Math.abs((cPosData.x as number) - 25) < 0.01);
    assert.equal(m1t2.updated.length, 1); // B dirty
    assert.equal(m1t2.updated[0].netId, nB);
    assert.ok(Math.abs((m1t2.updated[0].data.y as number) - 7) < 0.01);

    const m3t2 = decoder.decode(await p3t2, registry) as DeltaMessage;
    // Client 3: B updated (y=7), D enters
    assert.equal(m3t2.created.size, 1); // D enters
    assert.ok(m3t2.created.has(nD));
    assert.equal(m3t2.updated.length, 1); // B dirty
    assert.equal(m3t2.updated[0].netId, nB);

    // ── Tick 3: entity destroyed globally while in some views ──
    em.destroyEntity(eD);
    em.set(eA, Health.hp, 50);

    const p1t3 = recv(ws1);
    // Client 2 sees D destroyed
    const p2t3 = recv(ws2);
    const p3t3 = recv(ws3);

    server.tick((cid) => {
      if (cid === cid1) return new Set([nA, nB, nC]);
      if (cid === cid2) return new Set([nC]);        // D destroyed, drop it
      return new Set([nB, nC]);                       // D destroyed, drop it
    });

    const m1t3 = decoder.decode(await p1t3, registry) as DeltaMessage;
    // Client 1: A updated (hp=50), D not in view so no leave
    assert.equal(m1t3.updated.length, 1);
    assert.equal(m1t3.updated[0].netId, nA);
    assert.equal(m1t3.updated[0].data.hp, 50);
    assert.equal(m1t3.destroyed.length, 0); // D was never in client 1's view

    const m2t3 = decoder.decode(await p2t3, registry) as DeltaMessage;
    // Client 2: D globally destroyed and was known → leave
    assert.equal(m2t3.destroyed.length, 1);
    assert.equal(m2t3.destroyed[0], nD);
    assert.equal(m2t3.updated.length, 0); // A not in view

    const m3t3 = decoder.decode(await p3t3, registry) as DeltaMessage;
    // Client 3: D globally destroyed and was known (entered tick 2) → leave
    assert.equal(m3t3.destroyed.length, 1);
    assert.equal(m3t3.destroyed[0], nD);
    assert.equal(m3t3.updated.length, 0);

    // ── Tick 4: new entity created + C.y updated so all clients get a message ──
    const eE = em.createEntityWith(Position, { x: 50, y: 50 }, Networked);
    em.set(eC, Position.y, 99); // dirty C so client 2 and 3 also get a delta

    const p1t4 = recv(ws1);
    const p2t4 = recv(ws2);
    const p3t4 = recv(ws3);

    server.tick((cid) => {
      if (cid === cid1) return new Set([nA, nB, nC, 5]); // netId 5 = eE (next after 4)
      if (cid === cid2) return new Set([nC]);
      return new Set([nB, nC]);
    });

    const m1t4 = decoder.decode(await p1t4, registry) as DeltaMessage;
    // Client 1: new entity enters + C updated
    assert.equal(m1t4.created.size, 1);
    const newNetId = [...m1t4.created.keys()][0];
    const ePosData = m1t4.created.get(newNetId)!.get(0)!;
    assert.ok(Math.abs((ePosData.x as number) - 50) < 0.01);
    assert.ok(Math.abs((ePosData.y as number) - 50) < 0.01);
    assert.equal(m1t4.updated.length, 1); // C.y
    assert.equal(m1t4.updated[0].netId, nC);

    const m2t4 = decoder.decode(await p2t4, registry) as DeltaMessage;
    // Client 2: no new entity (not in interest), only C.y update
    assert.equal(m2t4.created.size, 0);
    assert.equal(m2t4.updated.length, 1);
    assert.equal(m2t4.updated[0].netId, nC);
    assert.ok(Math.abs((m2t4.updated[0].data.y as number) - 99) < 0.01);

    const m3t4 = decoder.decode(await p3t4, registry) as DeltaMessage;
    // Client 3: no new entity, only C.y update
    assert.equal(m3t4.created.size, 0);
    assert.equal(m3t4.updated.length, 1);
    assert.equal(m3t4.updated[0].netId, nC);

    ws1.terminate();
    ws2.terminate();
    ws3.terminate();
    await server.stop();
  });

  it('deduplicates encoding for clients with identical deltas', async () => {
    const em = createEntityManager();
    const decoder = new ProtocolDecoder();

    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);

    // Mock transport that tracks send calls and buffers
    const sent: { clientId: number; data: ArrayBuffer }[] = [];
    const mockTransport = {
      async start(_port: number, handlers: any) {
        // Simulate 3 clients connecting
        for (let i = 1; i <= 3; i++) handlers.onOpen(i);
      },
      async stop() {},
      send(clientId: number, data: ArrayBuffer) { sent.push({ clientId, data }); },
      broadcast(data: ArrayBuffer) {},
    };

    const server = createNetServer(em, registry, { port: 0 }, mockTransport as any);
    await server.start();
    sent.length = 0; // clear full state sends

    // Baseline tick
    server.tick(() => new Set(server.clientCount > 0 ? [1] : []));
    sent.length = 0;

    // All 3 clients see the same entity, update it
    em.set(e1, Position.x, 99);

    const allSee = new Set([1]); // netId 1
    server.tick(() => allSee);

    // All 3 should receive a message
    assert.equal(sent.length, 3);

    // All 3 should receive the exact same ArrayBuffer reference (dedup)
    assert.strictEqual(sent[0].data, sent[1].data);
    assert.strictEqual(sent[1].data, sent[2].data);

    // Verify content is correct
    const msg = decoder.decode(sent[0].data, registry) as DeltaMessage;
    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].netId, 1);
    assert.ok(Math.abs((msg.updated[0].data.x as number) - 99) < 0.01);

    await server.stop();
  });
});
