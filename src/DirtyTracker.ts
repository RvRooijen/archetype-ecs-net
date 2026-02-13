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

export interface AttachEntry {
  readonly netId: number;
  readonly entityId: EntityId;
  readonly wireIds: readonly number[];
}

export interface DetachEntry {
  readonly netId: number;
  readonly wireIds: readonly number[];
}

export interface Changeset {
  readonly created: readonly CreatedEntry[];
  readonly destroyed: readonly number[];
  readonly dirty: readonly DirtyEntry[];
  readonly attached: readonly AttachEntry[];
  readonly detached: readonly DetachEntry[];
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
  /** Pre-encoded bytes for attached entries (varint netId + wireCount + [wireId + allFields]*) */
  readonly attachSlices: ReadonlyMap<number, Uint8Array>;
  /** Pre-encoded bytes for detached entries (varint netId + wireCount + [wireId]*) */
  readonly detachSlices: ReadonlyMap<number, Uint8Array>;
}

// ── SnapshotDiffer ───────────────────────────────────────

export interface SnapshotDiffer {
  /** Diff + encode in a single pass — avoids intermediate allocations (broadcast mode) */
  diffAndEncode(encoder: ProtocolEncoder): ArrayBuffer;

  /** Phase 1: compute what changed this tick (run once, then encode per client) */
  computeChangeset(): Changeset;

  /** Pre-encode all entities in a changeset into cached byte slices (1× per tick) */
  preEncodeChangeset(encoder: ProtocolEncoder, changeset: Changeset, extraEnterNetIds: Iterable<number>): EntityCache;

  /** Compose a per-client delta buffer from pre-encoded cache (fast memcpy path) */
  composeFromCache(encoder: ProtocolEncoder, cache: EntityCache, clientDelta: ClientDelta): ArrayBuffer;

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

  // ── Presence tracking for attach/detach detection ──
  const prevPresence = new Map<number, Set<number>>();   // netId → set of wireIds last tick
  const entityArchId = new Map<number, number>();         // netId → archetype id last tick

  /** Get current wireIds for an entity by probing the ECS */
  function getCurrentWireIds(eid: EntityId): number[] {
    const wires: number[] = [];
    for (const cf of compFields) {
      if (em.get(eid, cf.refs[0].ref) !== undefined) wires.push(cf.wireId);
    }
    return wires;
  }

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

  // ── Shared helper: encode an attached entry ──

  function writeAttachedEntry(encoder: ProtocolEncoder, netId: number, eid: EntityId, wireIds: readonly number[]) {
    encoder.writeVarint(netId);
    encoder.writeU8(wireIds.length);
    for (const w of wireIds) {
      encoder.writeU8(w);
      for (const f of compFields[w].refs) {
        const regField = registry.components[w].fields[f.fieldIdx];
        encoder.writeField(regField.type, em.get(eid, f.ref));
      }
    }
  }

  // ── Shared helper: encode a detached entry ──

  function writeDetachedEntry(encoder: ProtocolEncoder, netId: number, wireIds: readonly number[]) {
    encoder.writeVarint(netId);
    encoder.writeU8(wireIds.length);
    for (const w of wireIds) {
      encoder.writeU8(w);
    }
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
    // Note: archetype-ecs reports removeComponent() as "destroyed" even when the
    // entity still has the Networked tag (archetype move). Filter those out.
    const destroyed: number[] = [];
    for (const eid of coreDestroyed) {
      // If entity still has Networked, it's just an archetype move, not a real destroy
      if (em.hasComponent(eid, Networked)) {
        coreDestroyed.delete(eid); // remove from set so downstream code doesn't skip it
        continue;
      }
      const netId = entityToNetId.get(eid);
      if (netId !== undefined) {
        destroyed.push(netId);
        entityToNetId.delete(eid);
        netIdToEntityMap.delete(netId);
        prevPresence.delete(netId);
        entityArchId.delete(netId);
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

  // ── Shared helper: collect dirty entries + detect archetype moves ──

  function collectDirty(coreCreated: Set<EntityId>, coreDestroyed: Set<EntityId>): { dirty: DirtyEntry[]; moved: Set<number> } {
    const dirty: DirtyEntry[] = [];
    const moved = new Set<number>();

    em.forEach([Networked], (a: ArchetypeView) => {
      const count = a.count;
      const entityIds = a.entityIds;
      const archId = (a as any).id as number;

      // Pass 1: check ALL entities for archetype moves (cheap: one Map lookup)
      for (let i = 0; i < count; i++) {
        const eid = entityIds[i];
        if (coreDestroyed.has(eid)) continue;
        const netId = entityToNetId.get(eid);
        if (netId === undefined) continue;

        if (coreCreated.has(eid)) {
          // New entity — just initialize tracking, no move detection
          entityArchId.set(netId, archId);
          continue;
        }

        const prevArch = entityArchId.get(netId);
        if (prevArch !== undefined && prevArch !== archId) moved.add(netId);
        entityArchId.set(netId, archId);
      }

      // Pass 2: existing field-level diff (skip moved entities)
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
        if (moved.has(netId)) continue;

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

    return { dirty, moved };
  }

  // ── Shared helper: process moved entities → attached/detached/synthetic dirty ──

  function processMovedEntities(
    moved: Set<number>,
    created: readonly CreatedEntry[],
  ): { attached: AttachEntry[]; detached: DetachEntry[]; syntheticDirty: DirtyEntry[] } {
    const attached: AttachEntry[] = [];
    const detached: DetachEntry[] = [];
    const syntheticDirty: DirtyEntry[] = [];

    for (const netId of moved) {
      const eid = netIdToEntityMap.get(netId);
      if (eid === undefined) continue;

      const currentWires = getCurrentWireIds(eid);
      const currentSet = new Set(currentWires);
      const prev = prevPresence.get(netId);

      const attachedWires: number[] = [];
      const detachedWires: number[] = [];
      const unchangedWires: number[] = [];

      if (prev) {
        for (const w of currentWires) {
          if (prev.has(w)) unchangedWires.push(w);
          else attachedWires.push(w);
        }
        for (const w of prev) {
          if (!currentSet.has(w)) detachedWires.push(w);
        }
      } else {
        // No previous presence (shouldn't happen for moved entities, but be safe)
        for (const w of currentWires) attachedWires.push(w);
      }

      if (attachedWires.length > 0) {
        attached.push({ netId, entityId: eid, wireIds: attachedWires });
      }
      if (detachedWires.length > 0) {
        detached.push({ netId, wireIds: detachedWires });
      }

      // Synthetic dirty: all fields of unchanged components marked as dirty
      if (unchangedWires.length > 0) {
        const masks = new Uint16Array(maxWireId + 1);
        for (const w of unchangedWires) {
          masks[w] = (1 << compFields[w].refs.length) - 1; // full bitmask
        }
        syntheticDirty.push({ netId, entityId: eid, dirtyMasks: masks });
      }

      // Update prevPresence for moved entity
      prevPresence.set(netId, currentSet);
    }

    return { attached, detached, syntheticDirty };
  }

  /** Initialize prevPresence for newly created entities */
  function initPresenceForCreated(created: readonly CreatedEntry[]) {
    for (const entry of created) {
      const wires = getCurrentWireIds(entry.entityId);
      prevPresence.set(entry.netId, new Set(wires));
    }
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

    // ── Broadcast mode: diff + encode ──

    diffAndEncode(encoder: ProtocolEncoder): ArrayBuffer {
      const { coreCreated, coreDestroyed } = flushAndPrepare();
      const { created, destroyed } = processCreateDestroy(coreCreated, coreDestroyed);
      const { dirty, moved } = collectDirty(coreCreated, coreDestroyed);
      const { attached, detached, syntheticDirty } = processMovedEntities(moved, created);
      const allDirty = dirty.concat(syntheticDirty);
      initPresenceForCreated(created);

      // ── Encode ────────────────────────────────────────
      encoder.reset();
      encoder.writeU8(MSG_DELTA);

      // Created
      encoder.writeU16(created.length);
      for (const entry of created) {
        encoder.writeVarint(entry.netId);
        writeEntityComponents(encoder, entry.entityId);
      }

      // Destroyed
      encoder.writeU16(destroyed.length);
      for (const netId of destroyed) encoder.writeVarint(netId);

      // Updated
      encoder.writeU16(allDirty.length);
      for (const entry of allDirty) {
        encodeDirtyEntity(encoder, entry);
      }

      // Attached
      encoder.writeU16(attached.length);
      for (const entry of attached) {
        writeAttachedEntry(encoder, entry.netId, entry.entityId, entry.wireIds);
      }

      // Detached
      encoder.writeU16(detached.length);
      for (const entry of detached) {
        writeDetachedEntry(encoder, entry.netId, entry.wireIds);
      }

      (em as any).flushSnapshots();
      return encoder.finish();
    },

    // ── Interest mode: Phase 1 — compute changeset ──

    computeChangeset(): Changeset {
      const { coreCreated, coreDestroyed } = flushAndPrepare();
      const { created, destroyed } = processCreateDestroy(coreCreated, coreDestroyed);
      const { dirty, moved } = collectDirty(coreCreated, coreDestroyed);
      const { attached, detached, syntheticDirty } = processMovedEntities(moved, created);

      // Merge synthetic dirty entries into dirty list
      const allDirty = dirty.concat(syntheticDirty);

      // Initialize presence tracking for newly created entities
      initPresenceForCreated(created);

      const createdSet = new Set<number>();
      for (const c of created) createdSet.add(c.netId);
      const destroyedSet = new Set<number>();
      for (const d of destroyed) destroyedSet.add(d);

      return { created, destroyed, dirty: allDirty, attached, detached, createdSet, destroyedSet };
    },

    preEncodeChangeset(encoder: ProtocolEncoder, changeset: Changeset, extraEnterNetIds: Iterable<number>): EntityCache {
      const enterSlices = new Map<number, Uint8Array>();
      const updateSlices = new Map<number, Uint8Array>();
      const attachSlices = new Map<number, Uint8Array>();
      const detachSlices = new Map<number, Uint8Array>();

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

      // Pre-encode attached entries
      for (const entry of changeset.attached) {
        encoder.reset();
        writeAttachedEntry(encoder, entry.netId, entry.entityId, entry.wireIds);
        attachSlices.set(entry.netId, new Uint8Array(encoder.finish()));
      }

      // Pre-encode detached entries
      for (const entry of changeset.detached) {
        encoder.reset();
        writeDetachedEntry(encoder, entry.netId, entry.wireIds);
        detachSlices.set(entry.netId, new Uint8Array(encoder.finish()));
      }

      return { enterSlices, updateSlices, attachSlices, detachSlices };
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

      // Attached section
      encoder.writeU16(clientDelta.attached.length);
      for (const netId of clientDelta.attached) {
        const slice = cache.attachSlices.get(netId);
        if (slice) encoder.writeBytes(slice);
      }

      // Detached section
      encoder.writeU16(clientDelta.detached.length);
      for (const netId of clientDelta.detached) {
        const slice = cache.detachSlices.get(netId);
        if (slice) encoder.writeBytes(slice);
      }

      return encoder.finish();
    },

    flushSnapshots() {
      (em as any).flushSnapshots();
    },
  };
}
