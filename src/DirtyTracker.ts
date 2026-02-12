import type { EntityId, EntityManager, ComponentType, ArchetypeView } from 'archetype-ecs';
import { component } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import { ProtocolEncoder } from './Protocol.js';
import type { WireType } from './types.js';
import { MSG_DELTA } from './types.js';
import type { ClientDelta } from './InterestManager.js';

/** Tag component — add to any entity that should be synced over the network */
export const Networked: ComponentType = component('Networked');

// ── Changeset types ──────────────────────────────────────

export interface CreatedEntry {
  readonly netId: number;
  readonly entityId: EntityId;
}

export interface DirtyEntry {
  readonly netId: number;
  readonly entityId: EntityId;
  /** Per-wireId dirty field bitmask (copy, safe to read after compute) */
  readonly dirtyMasks: Uint16Array;
}

export interface Changeset {
  readonly created: readonly CreatedEntry[];
  readonly destroyed: readonly number[];
  readonly dirty: readonly DirtyEntry[];
  /** Fast lookup sets for created/destroyed netIds */
  readonly createdSet: ReadonlySet<number>;
  readonly destroyedSet: ReadonlySet<number>;
}

// ── EntityCache ─────────────────────────────────────────

export interface EntityCache {
  /** Pre-encoded bytes for entity enters (varint netId + full component data) */
  readonly enterSlices: ReadonlyMap<number, Uint8Array>;
  /** Pre-encoded bytes for dirty entity updates (varint netId + dirty components) */
  readonly updateSlices: ReadonlyMap<number, Uint8Array>;
}

// ── SnapshotDiffer ───────────────────────────────────────

export interface SnapshotDiffer {
  /** Diff + encode in a single pass — avoids intermediate allocations (broadcast mode) */
  diffAndEncode(encoder: ProtocolEncoder): ArrayBuffer;

  /** Phase 1: compute what changed this tick (run once, then encode per client) */
  computeChangeset(): Changeset;

  /** Phase 2: encode a per-client delta from a changeset + client delta */
  encodeChangeset(encoder: ProtocolEncoder, changeset: Changeset, clientDelta: ClientDelta): ArrayBuffer;

  /** Pre-encode all entities in a changeset into cached byte slices (1× per tick) */
  preEncodeChangeset(encoder: ProtocolEncoder, changeset: Changeset, extraEnterNetIds: Iterable<number>): EntityCache;

  /** Compose a per-client delta buffer from pre-encoded cache (fast memcpy path) */
  composeFromCache(encoder: ProtocolEncoder, cache: EntityCache, clientDelta: ClientDelta): ArrayBuffer;

  /** Encode full component data for a single entity (for view-enter encoding) */
  encodeEntityComponents(encoder: ProtocolEncoder, entityId: EntityId): void;

  /** Flush snapshot buffers. Must call after all encoding is done when using computeChangeset(). */
  flushSnapshots(): void;

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

  // ── Shared helper: encode all components of an entity from live ECS ──

  function writeEntityComponents(encoder: ProtocolEncoder, eid: EntityId) {
    const compCountOff = encoder.reserveU8();
    let compCount = 0;
    for (const cf of compFields) {
      const firstVal = em.get(eid, cf.refs[0].ref);
      if (firstVal === undefined) continue;
      compCount++;
      encoder.writeU8(cf.wireId);
      for (const f of cf.refs) {
        const regField = registry.components[cf.wireId].fields[f.fieldIdx];
        encoder.writeField(regField.type, em.get(eid, f.ref));
      }
    }
    encoder.patchU8(compCountOff, compCount);
  }

  // ── Shared helper: flush ECS changes + handle first-diff ──

  function flushAndPrepare(): { coreCreated: Set<EntityId>; coreDestroyed: Set<EntityId> } {
    const changes = (em as any).flushChanges();
    const coreCreated: Set<EntityId> = changes.created;
    const coreDestroyed: Set<EntityId> = changes.destroyed;

    if (firstDiff) {
      firstDiff = false;
      const existing = em.query([Networked]);
      for (const eid of existing) {
        if (!coreCreated.has(eid)) coreCreated.add(eid);
      }
    }

    return { coreCreated, coreDestroyed };
  }

  // ── Shared helper: process creates + destroys, update netId maps ──

  function processCreateDestroy(coreCreated: Set<EntityId>, coreDestroyed: Set<EntityId>) {
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

    // Assign netIds to created entities (excluding immediately destroyed)
    const created: CreatedEntry[] = [];
    for (const eid of coreCreated) {
      if (coreDestroyed.has(eid)) continue;
      const netId = nextNetId++;
      entityToNetId.set(eid, netId);
      netIdToEntityMap.set(netId, eid);
      created.push({ netId, entityId: eid });
    }

    return { created, destroyed };
  }

  // ── Shared helper: collect dirty entries from archetype iteration ──

  function collectDirty(coreCreated: Set<EntityId>, coreDestroyed: Set<EntityId>): DirtyEntry[] {
    const dirty: DirtyEntry[] = [];

    em.forEach([Networked], (a: ArchetypeView) => {
      const count = a.count;
      const entityIds = a.entityIds;
      const snapCount = (a as any).snapshotCount as number;
      const snapEids = (a as any).snapshotEntityIds as EntityId[] | null;
      if (!snapEids || snapCount === 0) return;

      const minCount = count < snapCount ? count : snapCount;

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

      for (let i = 0; i < minCount; i++) {
        const eid = entityIds[i];
        if (eid !== snapEids[i]) continue;
        if (coreCreated.has(eid) || coreDestroyed.has(eid)) continue;

        const netId = entityToNetId.get(eid);
        if (netId === undefined) continue;

        let hasDirty = false;
        const masks = new Uint16Array(maxWireId + 1);
        for (let f = 0; f < fieldArrs.length; f++) {
          const fa = fieldArrs[f];
          if (fa.front[i] !== fa.back[i]) {
            masks[fa.wireId] |= (1 << fa.fieldIdx);
            hasDirty = true;
          }
        }

        if (hasDirty) {
          dirty.push({ netId, entityId: eid, dirtyMasks: masks });
        }
      }
    });

    return dirty;
  }

  // ── Shared helper: encode a dirty entry's updated fields ──

  function encodeDirtyEntity(encoder: ProtocolEncoder, entry: DirtyEntry) {
    encoder.writeVarint(entry.netId);
    const compCountOff = encoder.reserveU8();
    let compCount = 0;

    for (let w = 0; w <= maxWireId; w++) {
      const mask = entry.dirtyMasks[w];
      if (mask === 0) continue;

      compCount++;
      encoder.writeU8(w);
      encoder.writeU16(mask);

      // Write dirty field values from live ECS
      for (const f of compFields[w].refs) {
        if (mask & (1 << f.fieldIdx)) {
          const regField = registry.components[w].fields[f.fieldIdx];
          encoder.writeField(regField.type, em.get(entry.entityId, f.ref));
        }
      }
    }
    encoder.patchU8(compCountOff, compCount);
  }

  return {
    get entityNetIds(): ReadonlyMap<EntityId, number> {
      return entityToNetId;
    },
    get netIdToEntity(): ReadonlyMap<number, EntityId> {
      return netIdToEntityMap;
    },

    // ── Broadcast mode: original fused diff+encode (unchanged behavior) ──

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
        writeEntityComponents(encoder, eid);
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

            for (let w = 0; w <= maxWireId; w++) {
              const mask = dirtyMasks[w];
              if (mask === 0) continue;
              dirtyMasks[w] = 0;

              compCount++;
              encoder.writeU8(w);
              encoder.writeU16(mask);

              for (let f = 0; f < fieldArrs.length; f++) {
                const fa = fieldArrs[f];
                if (fa.wireId === w && (mask & (1 << fa.fieldIdx))) {
                  encoder.writeField(fa.type, fa.front[i]);
                }
              }
            }
            encoder.patchU8(compCountOff, compCount);
          } else {
            for (let w = 0; w <= maxWireId; w++) dirtyMasks[w] = 0;
          }
        }
      });

      encoder.patchU16(updateCountOff, updateCount);
      (em as any).flushSnapshots();
      return encoder.finish();
    },

    // ── Interest mode: Phase 1 — compute changeset ──

    computeChangeset(): Changeset {
      const { coreCreated, coreDestroyed } = flushAndPrepare();
      const { created, destroyed } = processCreateDestroy(coreCreated, coreDestroyed);
      const dirty = collectDirty(coreCreated, coreDestroyed);

      const createdSet = new Set<number>();
      for (const c of created) createdSet.add(c.netId);
      const destroyedSet = new Set<number>();
      for (const d of destroyed) destroyedSet.add(d);

      return { created, destroyed, dirty, createdSet, destroyedSet };
    },

    // ── Interest mode: Phase 2 — encode per-client delta ──

    encodeChangeset(encoder: ProtocolEncoder, changeset: Changeset, clientDelta: ClientDelta): ArrayBuffer {
      encoder.reset();
      encoder.writeU8(MSG_DELTA);

      // Created section: entities entering this client's view
      encoder.writeU16(clientDelta.enters.length);
      const globalCreatedMap = new Map<number, EntityId>();
      for (const c of changeset.created) globalCreatedMap.set(c.netId, c.entityId);

      for (const netId of clientDelta.enters) {
        encoder.writeVarint(netId);
        // Entity might be globally created or just entering this client's view
        const eid = globalCreatedMap.get(netId) ?? netIdToEntityMap.get(netId);
        if (eid !== undefined) {
          writeEntityComponents(encoder, eid);
        } else {
          encoder.patchU8(encoder.reserveU8(), 0); // 0 components (shouldn't happen)
        }
      }

      // Destroyed section: entities leaving this client's view
      encoder.writeU16(clientDelta.leaves.length);
      for (const netId of clientDelta.leaves) encoder.writeVarint(netId);

      // Updated section: dirty entities still in this client's view
      const dirtyMap = new Map<number, DirtyEntry>();
      for (const d of changeset.dirty) dirtyMap.set(d.netId, d);

      encoder.writeU16(clientDelta.updates.length);
      for (const netId of clientDelta.updates) {
        const entry = dirtyMap.get(netId);
        if (entry) {
          encodeDirtyEntity(encoder, entry);
        }
      }

      return encoder.finish();
    },

    encodeEntityComponents(encoder: ProtocolEncoder, entityId: EntityId) {
      writeEntityComponents(encoder, entityId);
    },

    preEncodeChangeset(encoder: ProtocolEncoder, changeset: Changeset, extraEnterNetIds: Iterable<number>): EntityCache {
      const enterSlices = new Map<number, Uint8Array>();
      const updateSlices = new Map<number, Uint8Array>();

      // Pre-encode created entities (global creates that may enter views)
      for (const entry of changeset.created) {
        encoder.reset();
        encoder.writeVarint(entry.netId);
        writeEntityComponents(encoder, entry.entityId);
        enterSlices.set(entry.netId, new Uint8Array(encoder.finish()));
      }

      // Pre-encode extra enters (existing entities entering a client's view)
      for (const netId of extraEnterNetIds) {
        if (enterSlices.has(netId)) continue; // already encoded as created
        const eid = netIdToEntityMap.get(netId);
        if (eid === undefined) continue;
        encoder.reset();
        encoder.writeVarint(netId);
        writeEntityComponents(encoder, eid);
        enterSlices.set(netId, new Uint8Array(encoder.finish()));
      }

      // Pre-encode dirty entity updates
      for (const entry of changeset.dirty) {
        encoder.reset();
        encodeDirtyEntity(encoder, entry);
        updateSlices.set(entry.netId, new Uint8Array(encoder.finish()));
      }

      return { enterSlices, updateSlices };
    },

    composeFromCache(encoder: ProtocolEncoder, cache: EntityCache, clientDelta: ClientDelta): ArrayBuffer {
      encoder.reset();
      encoder.writeU8(MSG_DELTA);

      // Created section
      encoder.writeU16(clientDelta.enters.length);
      for (const netId of clientDelta.enters) {
        const slice = cache.enterSlices.get(netId);
        if (slice) encoder.writeBytes(slice);
      }

      // Destroyed section
      encoder.writeU16(clientDelta.leaves.length);
      for (const netId of clientDelta.leaves) encoder.writeVarint(netId);

      // Updated section
      encoder.writeU16(clientDelta.updates.length);
      for (const netId of clientDelta.updates) {
        const slice = cache.updateSlices.get(netId);
        if (slice) encoder.writeBytes(slice);
      }

      return encoder.finish();
    },

    flushSnapshots() {
      (em as any).flushSnapshots();
    },
  };
}
