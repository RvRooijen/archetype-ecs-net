import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { createSnapshotDiffer, Networked } from '../src/DirtyTracker.js';
import { ProtocolEncoder, ProtocolDecoder } from '../src/Protocol.js';
import type { DeltaMessage } from '../src/types.js';

const Wide = component('Wide', 'f32', [
  'f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7',
  'f8', 'f9',
]);

const wideRegistry = createComponentRegistry([
  { component: Wide, name: 'Wide' },
]);

describe('Field bitmask u16', () => {
  it('correctly syncs all 10 fields including index >= 8', () => {
    const em = createEntityManager();
    const e1 = em.createEntityWith(
      Wide, { f0: 0, f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, f6: 0, f7: 0, f8: 0, f9: 0 },
      Networked,
    );
    const differ = createSnapshotDiffer(em, wideRegistry);
    const encoder = new ProtocolEncoder();
    const decoder = new ProtocolDecoder();

    differ.diffAndEncode(encoder); // baseline

    for (let i = 0; i < 10; i++) {
      em.set(e1, (Wide as any)[`f${i}`], (i + 1) * 10);
    }
    const buf = differ.diffAndEncode(encoder);
    const msg = decoder.decode(buf, wideRegistry) as DeltaMessage;

    assert.equal(msg.updated.length, 1);
    assert.equal(msg.updated[0].fieldMask, 0x3FF, 'bits 0-9 all set');
    for (let i = 0; i < 10; i++) {
      const val = msg.updated[0].data[`f${i}`] as number;
      assert.ok(Math.abs(val - (i + 1) * 10) < 0.001, `f${i} = ${(i + 1) * 10}`);
    }
  });

  it('rejects components with >16 fields', () => {
    const TooWide = component('TooWide', 'f32', [
      'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
      'a8', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14', 'a15',
      'a16',
    ]);

    assert.throws(
      () => createComponentRegistry([{ component: TooWide, name: 'TooWide' }]),
      { message: /max 16/i },
    );
  });
});
