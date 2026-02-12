import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder, ProtocolDecoder } from '../src/Protocol.js';
import type { DeltaMessage } from '../src/types.js';
import { MSG_DELTA } from '../src/types.js';

const Position = component('MismatchPos', 'f32', ['x', 'y']);

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
]);

describe('diffAndEncode correctness (bug #5 regression)', () => {
  it('created entities are encoded correctly', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    em.createEntityWith(Position, { x: 7, y: 8 }, Networked);
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.type, MSG_DELTA);
    assert.equal(msg.created.size, 1);
    const compMap = msg.created.get(1)!;
    assert.equal(compMap.size, 1);
    assert.ok(compMap.has(0));
    assert.ok(Math.abs((compMap.get(0)!.x as number) - 7) < 0.001);
    assert.ok(Math.abs((compMap.get(0)!.y as number) - 8) < 0.001);
  });

  it('update count is correct for field changes', () => {
    const em = createEntityManager();
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    // Change only x
    em.set(e1, Position.x, 99);
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].netId, 1);
    assert.equal(msg.updated[0].componentWireId, 0);
    assert.ok(Math.abs((msg.updated[0].data.x as number) - 99) < 0.001);
    assert.equal(msg.updated[0].data.y, undefined); // y not dirty
  });

  it('no changes produces empty delta, not a crash', () => {
    const em = createEntityManager();
    em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    // No changes
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.created.size, 0);
    assert.equal(msg.destroyed.length, 0);
    assert.equal(msg.updated.length, 0);
  });

  it('destroy + create in same tick works', () => {
    const em = createEntityManager();
    const e1 = em.createEntityWith(Position, { x: 1, y: 2 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    em.destroyEntity(e1);
    em.createEntityWith(Position, { x: 10, y: 20 }, Networked);
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.destroyed.length, 1);
    assert.equal(msg.destroyed[0], 1); // netId=1 destroyed
    assert.equal(msg.created.size, 1);
    assert.ok(msg.created.has(2)); // netId=2 created
  });
});
