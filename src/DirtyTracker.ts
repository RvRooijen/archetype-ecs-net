import type { EntityId, EntityManager, ComponentType, ArchetypeView } from 'archetype-ecs';
import { component } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import type { Delta, DirtyField } from './types.js';

/** Tag component — add to any entity that should be synced over the network */
export const Networked: ComponentType = component('Networked');

export interface SnapshotDiffer {
  /** Compare current ECS state against previous snapshot, return delta */
  diff(): Delta;
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
  const compFields: { wireId: number; refs: { name: string; ref: any }[] }[] = [];
  for (const reg of registry.components) {
    const refs: { name: string; ref: any }[] = [];
    for (const field of reg.fields) {
      refs.push({ name: field.name, ref: (reg.component as any)[field.name] });
    }
    compFields.push({ wireId: reg.wireId, refs });
  }

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

    diff(): Delta {
      const changes = (em as any).flushChanges();
      const coreCreated: Set<EntityId> = changes.created;
      const coreDestroyed: Set<EntityId> = changes.destroyed;

      const createdMap = new Map<number, Map<number, Record<string, unknown>>>();
      const destroyed: number[] = [];
      const updated = new Map<number, DirtyField[]>();

      // First diff: treat all existing Networked entities as created (baseline)
      if (firstDiff) {
        firstDiff = false;
        const existing = em.query([Networked]);
        for (const eid of existing) {
          if (!coreCreated.has(eid)) {
            coreCreated.add(eid);
          }
        }
      }

      // Handle destroyed — collect netIds before removing from map
      for (const eid of coreDestroyed) {
        const netId = entityToNetId.get(eid);
        if (netId !== undefined) {
          destroyed.push(netId);
          entityToNetId.delete(eid);
          netIdToEntityMap.delete(netId);
        }
      }

      // Handle created — assign netId, collect full component data
      for (const eid of coreCreated) {
        if (coreDestroyed.has(eid)) continue;
        const netId = nextNetId++;
        entityToNetId.set(eid, netId);
        netIdToEntityMap.set(netId, eid);

        const compMap = new Map<number, Record<string, unknown>>();
        for (const cf of compFields) {
          let rec: Record<string, unknown> | undefined;
          for (const f of cf.refs) {
            const val = em.get(eid, f.ref);
            if (val !== undefined) {
              if (!rec) { rec = {}; compMap.set(cf.wireId, rec); }
              rec[f.name] = val;
            }
          }
        }
        createdMap.set(netId, compMap);
      }

      // Diff using double-buffered snapshots: compare front vs back arrays
      // Only compare indices where entityIds match (swap-remove can reorder)
      em.forEach([Networked], (a: ArchetypeView) => {
        const count = a.count;
        const entityIds = a.entityIds;
        const snapCount = (a as any).snapshotCount as number;
        const snapEids = (a as any).snapshotEntityIds as EntityId[] | null;
        if (!snapEids || snapCount === 0) return; // no previous snapshot

        // Compare the min of current and snapshot count
        const minCount = count < snapCount ? count : snapCount;

        // Gather front/back arrays per component per field
        const allFieldArrs: { wireId: number; name: string; front: any; back: any }[] = [];
        for (const cf of compFields) {
          for (const f of cf.refs) {
            const front = a.field(f.ref);
            const back = (a as any).snapshot(f.ref);
            if (front && back) {
              allFieldArrs.push({ wireId: cf.wireId, name: f.name, front, back });
            }
          }
        }
        if (allFieldArrs.length === 0) return;

        for (let i = 0; i < minCount; i++) {
          const eid = entityIds[i];
          // Only compare if same entity sits at same index in both buffers
          if (eid !== snapEids[i]) continue;
          // Skip created/destroyed (handled above)
          if (coreCreated.has(eid) || coreDestroyed.has(eid)) continue;

          const netId = entityToNetId.get(eid);
          if (netId === undefined) continue;

          for (let f = 0; f < allFieldArrs.length; f++) {
            const fa = allFieldArrs[f];
            if (fa.front[i] !== fa.back[i]) {
              let fields = updated.get(netId);
              if (!fields) { fields = []; updated.set(netId, fields); }
              let df = fields.find(d => d.componentWireId === fa.wireId);
              if (!df) {
                df = { componentWireId: fa.wireId, fields: new Set() };
                fields.push(df);
              }
              df.fields.add(fa.name);
            }
          }
        }
      });

      // Flush snapshots: copy front → back (one .set() memcpy per field)
      (em as any).flushSnapshots();

      return { created: createdMap, destroyed, updated };
    },
  };
}
