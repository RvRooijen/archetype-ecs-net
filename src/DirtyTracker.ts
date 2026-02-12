import type { EntityId, EntityManager, ComponentType, ArchetypeView } from 'archetype-ecs';
import { component } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import { ProtocolEncoder } from './Protocol.js';
import type { WireType } from './types.js';
import { MSG_DELTA } from './types.js';

/** Tag component — add to any entity that should be synced over the network */
export const Networked: ComponentType = component('Networked');

export interface SnapshotDiffer {
  /** Diff + encode in a single pass — avoids intermediate allocations */
  diffAndEncode(encoder: ProtocolEncoder): ArrayBuffer;
  /** Current mapping of entityId → netId for all tracked entities */
  readonly entityNetIds: ReadonlyMap<EntityId, number>;
  /** Reverse mapping of netId → entityId */
  readonly netIdToEntity: ReadonlyMap<number, EntityId>;
}

export function createSnapshotDiffer(
  em: EntityManager,
  registry: ComponentRegistry,
): SnapshotDiffer {
  // Enable core-level change tracking + double-buffered snapshots
  (em as any).enableTracking(Networked);

  // Precompute field refs per registered component
  // Each field also carries its index within the component for bitmask building
  const compFields: { wireId: number; refs: { name: string; ref: any; fieldIdx: number }[] }[] = [];
  for (const reg of registry.components) {
    const refs: { name: string; ref: any; fieldIdx: number }[] = [];
    for (let fi = 0; fi < reg.fields.length; fi++) {
      const field = reg.fields[fi];
      refs.push({ name: field.name, ref: (reg.component as any)[field.name], fieldIdx: fi });
    }
    compFields.push({ wireId: reg.wireId, refs });
  }
  // Max wireId for pre-allocating sparse bitmask array
  const maxWireId = compFields.length > 0 ? compFields[compFields.length - 1].wireId : 0;

  let firstDiff = true;
  let nextNetId = 1;
  const entityToNetId = new Map<EntityId, number>();
  const netIdToEntityMap = new Map<number, EntityId>();

  return {
    get entityNetIds(): ReadonlyMap<EntityId, number> {
      return entityToNetId;
    },
    get netIdToEntity(): ReadonlyMap<number, EntityId> {
      return netIdToEntityMap;
    },

    diffAndEncode(encoder: ProtocolEncoder): ArrayBuffer {
      const changes = (em as any).flushChanges();
      const coreCreated: Set<EntityId> = changes.created;
      const coreDestroyed: Set<EntityId> = changes.destroyed;

      // First diff: treat all existing Networked entities as created
      if (firstDiff) {
        firstDiff = false;
        const existing = em.query([Networked]);
        for (const eid of existing) {
          if (!coreCreated.has(eid)) coreCreated.add(eid);
        }
      }

      // Collect destroyed netIds before removing from map
      const destroyed: number[] = [];
      for (const eid of coreDestroyed) {
        const netId = entityToNetId.get(eid);
        if (netId !== undefined) {
          destroyed.push(netId);
          entityToNetId.delete(eid);
          netIdToEntityMap.delete(netId);
        }
      }

      // ── Start encoding ────────────────────────────────
      encoder.reset();
      encoder.writeU8(MSG_DELTA);

      // Created: assign netIds, encode component data directly from ECS
      const createdEntities: EntityId[] = [];
      for (const eid of coreCreated) {
        if (!coreDestroyed.has(eid)) createdEntities.push(eid);
      }
      encoder.writeU16(createdEntities.length);

      for (const eid of createdEntities) {
        const netId = nextNetId++;
        entityToNetId.set(eid, netId);
        netIdToEntityMap.set(netId, eid);
        encoder.writeVarint(netId);

        const compCountOff = encoder.reserveU8();
        let compCount = 0;

        for (const cf of compFields) {
          // Check if entity has this component by testing first field
          const firstVal = em.get(eid, cf.refs[0].ref);
          if (firstVal === undefined) continue;
          compCount++;
          encoder.writeU8(cf.wireId);
          // Write all fields directly from ECS
          for (const f of cf.refs) {
            const regField = registry.components[cf.wireId].fields[f.fieldIdx];
            encoder.writeField(regField.type, em.get(eid, f.ref));
          }
        }
        encoder.patchU8(compCountOff, compCount);
      }

      // Destroyed
      encoder.writeU16(destroyed.length);
      for (const netId of destroyed) encoder.writeVarint(netId);

      // Updated — backpatch count, write directly from front buffers
      const updateCountOff = encoder.reserveU16();
      let updateCount = 0;

      em.forEach([Networked], (a: ArchetypeView) => {
        const count = a.count;
        const entityIds = a.entityIds;
        const snapCount = (a as any).snapshotCount as number;
        const snapEids = (a as any).snapshotEntityIds as EntityId[] | null;
        if (!snapEids || snapCount === 0) return;

        const minCount = count < snapCount ? count : snapCount;

        // Gather front/back arrays + field metadata for direct encoding
        const fieldArrs: {
          wireId: number; fieldIdx: number;
          front: any; back: any;
          type: WireType;
        }[] = [];
        for (const cf of compFields) {
          for (const f of cf.refs) {
            const front = a.field(f.ref);
            const back = (a as any).snapshot(f.ref);
            if (front && back) {
              const regField = registry.components[cf.wireId].fields[f.fieldIdx];
              fieldArrs.push({ wireId: cf.wireId, fieldIdx: f.fieldIdx, front, back, type: regField.type });
            }
          }
        }
        if (fieldArrs.length === 0) return;

        const dirtyMasks = new Uint16Array(maxWireId + 1);

        for (let i = 0; i < minCount; i++) {
          const eid = entityIds[i];
          if (eid !== snapEids[i]) continue;
          if (coreCreated.has(eid) || coreDestroyed.has(eid)) continue;

          const netId = entityToNetId.get(eid);
          if (netId === undefined) continue;

          // Collect dirty bitmasks
          let hasDirty = false;
          for (let f = 0; f < fieldArrs.length; f++) {
            const fa = fieldArrs[f];
            if (fa.front[i] !== fa.back[i]) {
              dirtyMasks[fa.wireId] |= (1 << fa.fieldIdx);
              hasDirty = true;
            }
          }

          if (hasDirty) {
            updateCount++;
            encoder.writeVarint(netId);
            const compCountOff = encoder.reserveU8();
            let compCount = 0;

            // Encode each dirty component
            for (let w = 0; w <= maxWireId; w++) {
              const mask = dirtyMasks[w];
              if (mask === 0) continue;
              dirtyMasks[w] = 0;

              compCount++;
              encoder.writeU8(w);
              encoder.writeU16(mask);

              // Write dirty field values directly from front buffer
              for (let f = 0; f < fieldArrs.length; f++) {
                const fa = fieldArrs[f];
                if (fa.wireId === w && (mask & (1 << fa.fieldIdx))) {
                  encoder.writeField(fa.type, fa.front[i]);
                }
              }
            }
            encoder.patchU8(compCountOff, compCount);
          }
        }
      });

      encoder.patchU16(updateCountOff, updateCount);

      // Flush snapshots
      (em as any).flushSnapshots();

      return encoder.finish();
    },
  };
}
