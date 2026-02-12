import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder, ProtocolDecoder } from '../src/Protocol.js';
import { MSG_FULL, MSG_DELTA } from '../src/types.js';
import type { FullStateMessage, DeltaMessage } from '../src/types.js';

// ── Test components ─────────────────────────────────────

const Position = component('Position', 'f32', ['x', 'y']);
const Health = component('Health', 'i32', ['hp', 'maxHp']);
const Name = component('Name', 'string', ['name']);

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health, name: 'Health' },
  { component: Name, name: 'Name' },
]);

// ── Tests ───────────────────────────────────────────────

describe('ComponentRegistry', () => {
  it('assigns wire IDs in order', () => {
    assert.equal(registry.byName('Position')?.wireId, 0);
    assert.equal(registry.byName('Health')?.wireId, 1);
    assert.equal(registry.byName('Name')?.wireId, 2);
  });

  it('resolves by symbol', () => {
    assert.equal(registry.bySymbol(Position._sym)?.name, 'Position');
  });

  it('stores field info', () => {
    const pos = registry.byName('Position')!;
    assert.equal(pos.fields.length, 2);
    assert.equal(pos.fields[0].name, 'x');
    assert.equal(pos.fields[0].type, 'f32');
    assert.equal(pos.fields[0].byteSize, 4);
  });
});

describe('Protocol - Full State', () => {
  it('encodes and decodes full state roundtrip', () => {
    const em = createEntityManager();
    em.createEntityWith(Position, { x: 1.5, y: 2.5 }, Health, { hp: 100, maxHp: 100 }, Networked);
    em.createEntityWith(Position, { x: 10, y: 20 }, Networked);

    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    differ.diffAndEncode(encoder); // establish baseline

    const decoder = new ProtocolDecoder();
    const buffer = encoder.encodeFullState(em, registry, differ.entityNetIds);
    const msg = decoder.decode(buffer, registry);

    assert.equal(msg.type, MSG_FULL);
    const full = msg as FullStateMessage;
    assert.equal(full.entities.size, 2);

    const e1Data = full.entities.get(1)!;
    const e1Pos = e1Data.get(0)!;
    assert.ok(Math.abs((e1Pos.x as number) - 1.5) < 0.001);
    const e1Hp = e1Data.get(1)!;
    assert.equal(e1Hp.hp, 100);

    const e2Data = full.entities.get(2)!;
    assert.equal(e2Data.size, 1);
  });

  it('handles string fields', () => {
    const em = createEntityManager();
    em.createEntityWith(Name, { name: 'Player1' }, Networked);

    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    differ.diffAndEncode(encoder); // establish baseline

    const decoder = new ProtocolDecoder();
    const buffer = encoder.encodeFullState(em, registry, differ.entityNetIds);
    const msg = decoder.decode(buffer, registry) as FullStateMessage;

    const nameData = msg.entities.get(1)!.get(2)!;
    assert.equal(nameData.name, 'Player1');
  });
});

describe('Protocol - Delta (fused path)', () => {
  it('encodes and decodes created entities', () => {
    const em = createEntityManager();
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    em.createEntityWith(Position, { x: 5, y: 10 }, Networked);
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.type, MSG_DELTA);
    assert.equal(msg.created.size, 1);
    assert.equal(msg.destroyed.length, 0);
    assert.equal(msg.updated.length, 0);

    const posData = msg.created.get(1)!.get(0)!;
    assert.ok(Math.abs((posData.x as number) - 5) < 0.001);
  });

  it('encodes and decodes destroyed entities', () => {
    const em = createEntityManager();
    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    em.destroyEntity(e1);
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.destroyed.length, 1);
    assert.equal(msg.destroyed[0], 1);
  });

  it('encodes and decodes field updates', () => {
    const em = createEntityManager();
    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Health, { hp: 100, maxHp: 100 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    em.set(e1, Position.x, 42.5);
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;

    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].netId, 1);
    assert.equal(msg.updated[0].componentWireId, 0);
    assert.ok(Math.abs((msg.updated[0].data.x as number) - 42.5) < 0.001);
    assert.equal(msg.updated[0].data.y, undefined);
  });

  it('empty delta when nothing changed', () => {
    const em = createEntityManager();
    em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

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

describe('SnapshotDiffer', () => {
  it('only tracks entities with Networked component', () => {
    const em = createEntityManager();
    em.createEntityWith(Position, { x: 1, y: 2 });
    em.createEntityWith(Position, { x: 3, y: 4 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;
    assert.equal(msg.created.size, 1);
  });

  it('detects removal of Networked component as destroy', () => {
    const em = createEntityManager();
    const e1 = em.createEntityWith(Position, { x: 0, y: 0 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    em.removeComponent(e1, Networked);
    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;
    assert.equal(msg.destroyed.length, 1);
    assert.equal(msg.destroyed[0], 1);
  });

  it('no changes between identical ticks', () => {
    const em = createEntityManager();
    em.createEntityWith(Position, { x: 5, y: 10 }, Networked);
    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;
    assert.equal(msg.created.size, 0);
    assert.equal(msg.destroyed.length, 0);
    assert.equal(msg.updated.length, 0);
  });

  it('assigns stable netIds independent of entity IDs', () => {
    const em = createEntityManager();

    const temp = em.createEntityWith(Position, { x: 0, y: 0 });
    const real = em.createEntityWith(Position, { x: 42, y: 99 }, Networked);
    em.destroyEntity(temp);

    const differ = createSnapshotDiffer(em, registry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    const buffer = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buffer, registry) as DeltaMessage;
    assert.equal(msg.created.size, 1);
    assert.ok(msg.created.has(1), 'netId=1 assigned');
    assert.equal(differ.entityNetIds.get(real), 1);
    assert.equal(differ.netIdToEntity.get(1), real);
  });
});
