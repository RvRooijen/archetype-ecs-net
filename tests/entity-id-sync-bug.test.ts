import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder, ProtocolDecoder } from '../src/Protocol.js';
import type { FullStateMessage, DeltaMessage } from '../src/types.js';

const Position = component('BugDemoPos', 'f32', ['x', 'y']);

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
]);

describe('Entity ID sync via netId', () => {
  it('client correctly maps entities despite non-sequential server entity IDs', () => {
    // ── SERVER: create a gap in entity IDs ──────────────
    const serverEm = createEntityManager();
    const temp = serverEm.createEntityWith(Position, { x: 0, y: 0 });
    const real = serverEm.createEntityWith(Position, { x: 42, y: 99 }, Networked);
    serverEm.destroyEntity(temp);

    // Server entity ID has a gap
    assert.ok(real > 1, `Server entity id=${real} has a gap`);

    // Differ assigns netId=1
    const differ = createSnapshotDiffer(serverEm, registry);
    differ.diff();
    assert.equal(differ.entityNetIds.get(real), 1);

    // ── Encode full state with netId ────────────────────
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();
    const fullBuf = encoder.encodeFullState(serverEm, registry, differ.entityNetIds);
    const fullMsg = decoder.decode(fullBuf, registry) as FullStateMessage;

    // Wire carries netId=1, not the raw entity ID
    assert.equal(fullMsg.entities.size, 1);
    assert.ok(fullMsg.entities.has(1), 'Wire uses netId=1');

    // ── CLIENT: apply full state with netId mapping ─────
    const clientEm = createEntityManager();
    const netToEntity = new Map<number, number>();

    for (const [netId, compMap] of fullMsg.entities) {
      const args: unknown[] = [];
      for (const [wireId, data] of compMap) {
        const reg = registry.byWireId(wireId);
        if (reg) args.push(reg.component, data);
      }
      const localId = args.length > 0
        ? clientEm.createEntityWith(...args)
        : clientEm.createEntity();
      netToEntity.set(netId, localId);
    }

    // Client created entity — netId=1 maps to the local ID
    const localId = netToEntity.get(1)!;
    assert.ok(localId !== undefined, 'netId=1 mapped to local entity');

    // Data is correct via the mapping
    const posX = clientEm.get(localId, Position.x) as number;
    assert.ok(Math.abs(posX - 42) < 0.01, 'Position.x=42 via netId lookup');
  });

  it('delta updates reach the correct entity via netId mapping', () => {
    // ── SERVER ───────────────────────────────────────────
    const serverEm = createEntityManager();
    const a = serverEm.createEntityWith(Position, { x: 0, y: 0 });
    const b = serverEm.createEntityWith(Position, { x: 0, y: 0 });
    const c = serverEm.createEntityWith(Position, { x: 100, y: 200 }, Networked);
    serverEm.destroyEntity(a);
    serverEm.destroyEntity(b);
    const d = serverEm.createEntityWith(Position, { x: 50, y: 60 }, Networked);

    const differ = createSnapshotDiffer(serverEm, registry);
    differ.diff(); // assigns netId=1 to c, netId=2 to d

    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    // ── Full state → client ─────────────────────────────
    const fullBuf = encoder.encodeFullState(serverEm, registry, differ.entityNetIds);
    const fullMsg = decoder.decode(fullBuf, registry) as FullStateMessage;

    const clientEm = createEntityManager();
    const netToEntity = new Map<number, number>();

    for (const [netId, compMap] of fullMsg.entities) {
      const args: unknown[] = [];
      for (const [wireId, data] of compMap) {
        const reg = registry.byWireId(wireId);
        if (reg) args.push(reg.component, data);
      }
      const localId = clientEm.createEntityWith(...args);
      netToEntity.set(netId, localId);
    }

    // ── Server updates entity c (netId=1) ───────────────
    serverEm.set(c, Position.x, 999);
    const delta = differ.diff();

    const deltaBuf = encoder.encodeDelta(delta, serverEm, registry, differ.netIdToEntity);
    const deltaMsg = decoder.decode(deltaBuf, registry) as DeltaMessage;

    // Delta targets netId=1
    assert.equal(deltaMsg.updated.length, 1);
    assert.equal(deltaMsg.updated[0].netId, 1);

    // ── Client applies delta via netId mapping ──────────
    for (const update of deltaMsg.updated) {
      const localId = netToEntity.get(update.netId);
      assert.ok(localId !== undefined, `netId=${update.netId} found in mapping`);

      const reg = registry.byWireId(update.componentWireId)!;
      for (const [fieldName, value] of Object.entries(update.data)) {
        const fieldRef = (reg.component as any)[fieldName];
        clientEm.set(localId!, fieldRef, value);
      }
    }

    // Verify: the correct client entity was updated
    const cLocal = netToEntity.get(1)!;
    const dLocal = netToEntity.get(2)!;

    assert.ok(Math.abs((clientEm.get(cLocal, Position.x) as number) - 999) < 0.01,
      'Entity c (netId=1) updated to x=999');
    assert.ok(Math.abs((clientEm.get(dLocal, Position.x) as number) - 50) < 0.01,
      'Entity d (netId=2) unchanged at x=50');
  });
});
