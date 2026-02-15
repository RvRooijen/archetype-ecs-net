import type { EntityId, EntityManager, ArchetypeView, ComponentDef } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import { Networked } from './DirtyTracker.js';
import { ProtocolDecoder, ProtocolEncoder } from './Protocol.js';
import { MSG_CLIENT_DELTA, MSG_CLIENT_ID, MSG_DELTA, MSG_FULL, MSG_RECONNECT, MSG_REQUEST_FULL } from './types.js';
import type { DeltaMessage, FullStateMessage, WireType } from './types.js';

export interface NetClientOptions {
  /** Component used for entity ownership. If set, only entities where
   *  `clientIdField` matches this client's ID will be diffed and sent. */
  ownerComponent?: { component: ComponentDef<any>; clientIdField: any };
  /** When more than this many MSG_DELTA messages queue up between ticks,
   *  discard them all and request a full state resync. 0 = disabled. Default 0. */
  burstThreshold?: number;
}

export interface NetClient {
  /** Connect to server */
  connect(url: string): void;
  /** Disconnect from server */
  disconnect(): void;
  /** Send a binary message to the server */
  send(data: ArrayBuffer): void;
  /** Diff client-owned components and send delta to server. Call once per frame. */
  tick(): void;
  /** Whether currently connected */
  readonly connected: boolean;
  /** Client ID assigned by the server on connect */
  readonly clientId: number;
  /** netId → local EntityId mapping (for rendering, input, etc.) */
  readonly netToEntity: ReadonlyMap<number, EntityId>;
  /** Returns all entity IDs owned by this client (requires ownerComponent option) */
  readonly ownedEntities: EntityId[];
  /** Reconnect token for session resumption. Save before unload and restore before connect() to survive page refreshes. */
  reconnectToken: number;
  /** Callbacks */
  onConnected: (() => void) | null;
  onDisconnected: (() => void) | null;
  onReconnected: (() => void) | null;
  /** Called for unrecognized messages (custom app messages) */
  onMessage: ((data: ArrayBuffer) => void) | null;
}

export function createNetClient(
  em: EntityManager,
  registry: ComponentRegistry,
  options?: NetClientOptions,
): NetClient {
  const decoder = new ProtocolDecoder();
  const encoder = new ProtocolEncoder();
  let ws: WebSocket | null = null;

  // Map wireId → component def for fast lookup during apply
  const wireToComponent = new Map<number, (typeof registry.components)[number]>();
  for (const reg of registry.components) {
    wireToComponent.set(reg.wireId, reg);
  }

  // netId → local entity ID mapping
  const netToEntity = new Map<number, EntityId>();

  // ── Client-owned component diffing ──────────────────────

  // Enable double-buffered snapshot tracking for diff
  (em as any).enableTracking(Networked);

  // Precompute field refs for clientOwned components only
  const ownedCompFields: { wireId: number; refs: { ref: any; fieldIdx: number; name: string }[] }[] = [];
  for (const reg of registry.components) {
    if (!reg.clientOwned) continue;
    const refs: { ref: any; fieldIdx: number; name: string }[] = [];
    for (let fi = 0; fi < reg.fields.length; fi++) {
      refs.push({ ref: (reg.component as any)[reg.fields[fi].name], fieldIdx: fi, name: reg.fields[fi].name });
    }
    ownedCompFields.push({ wireId: reg.wireId, refs });
  }
  const hasOwnedFields = ownedCompFields.length > 0;
  const maxOwnedWireId = hasOwnedFields
    ? ownedCompFields[ownedCompFields.length - 1].wireId
    : 0;

  // ── Presence tracking for client-owned attach/detach detection ──
  const prevOwnedPresence = new Map<number, Set<number>>();   // netId → set of clientOwned wireIds
  const clientEntityArchId = new Map<number, number>();        // netId → archetype id

  /** Get current clientOwned wireIds for an entity */
  function getCurrentOwnedWireIds(eid: EntityId): number[] {
    const wires: number[] = [];
    for (const cf of ownedCompFields) {
      if (em.get(eid, cf.refs[0].ref) !== undefined) wires.push(cf.wireId);
    }
    return wires;
  }

  let trackingInitialized = false;

  function diffAndSendOwned() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!hasOwnedFields) return;

    (em as any).flushChanges();

    if (!trackingInitialized) {
      trackingInitialized = true;
      // Initialize presence tracking for all known entities
      for (const [netId, eid] of netToEntity) {
        prevOwnedPresence.set(netId, new Set(getCurrentOwnedWireIds(eid)));
      }
      (em as any).flushSnapshots();
      return;
    }

    // Build reverse map entityId → netId
    const entityToNet = new Map<EntityId, number>();
    for (const [netId, eid] of netToEntity) {
      entityToNet.set(eid, netId);
    }

    encoder.reset();
    encoder.writeU8(MSG_CLIENT_DELTA);
    const updateCountOff = encoder.reserveU16();
    let updateCount = 0;

    // Precompute owner field ref for filtering
    const ownerRef = options?.ownerComponent?.clientIdField ?? null;

    // Track moved entities during forEach
    const moved = new Set<number>();

    // Collect attach/detach info for moved entities
    interface AttachInfo { netId: number; eid: EntityId; wireIds: number[] }
    interface DetachInfo { netId: number; wireIds: number[] }
    const attachedEntries: AttachInfo[] = [];
    const detachedEntries: DetachInfo[] = [];

    em.forEach([Networked], (a: ArchetypeView) => {
      const count = a.count;
      const entityIds = a.entityIds;
      const archId = (a as any).id as number;

      // Owner field array for filtering
      const ownerArr = ownerRef ? a.field(ownerRef) : null;

      // Pass 1: detect archetype moves for owned entities
      for (let i = 0; i < count; i++) {
        const eid = entityIds[i];
        const netId = entityToNet.get(eid);
        if (netId === undefined) continue;

        // Skip entities this client doesn't own
        if (ownerArr && ownerArr[i] !== _clientId) continue;

        const prevArch = clientEntityArchId.get(netId);
        if (prevArch !== undefined && prevArch !== archId) {
          moved.add(netId);
        }
        clientEntityArchId.set(netId, archId);
      }

      // Pass 2: field-level diff for non-moved owned entities
      const snapCount = (a as any).snapshotCount as number;
      const snapEids = (a as any).snapshotEntityIds as EntityId[] | null;
      if (!snapEids || snapCount === 0) return;

      const minCount = count < snapCount ? count : snapCount;

      // Gather front/back arrays for owned fields present in this archetype
      const fieldArrs: {
        wireId: number; fieldIdx: number;
        front: any; back: any;
        type: WireType;
      }[] = [];
      for (const cf of ownedCompFields) {
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

      const dirtyMasks = new Uint16Array(maxOwnedWireId + 1);

      for (let i = 0; i < minCount; i++) {
        const eid = entityIds[i];
        if (eid !== snapEids[i]) continue;

        const netId = entityToNet.get(eid);
        if (netId === undefined) continue;

        // Skip entities this client doesn't own
        if (ownerArr && ownerArr[i] !== _clientId) continue;

        // Skip moved entities — handled separately
        if (moved.has(netId)) continue;

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

          for (let w = 0; w <= maxOwnedWireId; w++) {
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
          for (let w = 0; w <= maxOwnedWireId; w++) dirtyMasks[w] = 0;
        }
      }
    });

    // Process moved entities: synthetic dirty for unchanged components + attach/detach
    for (const netId of moved) {
      const eid = netToEntity.get(netId);
      if (eid === undefined) continue;

      const currentWires = getCurrentOwnedWireIds(eid);
      const currentSet = new Set(currentWires);
      const prev = prevOwnedPresence.get(netId);

      const attachWires: number[] = [];
      const detachWires: number[] = [];
      const unchangedWires: number[] = [];

      if (prev) {
        for (const w of currentWires) {
          if (prev.has(w)) unchangedWires.push(w);
          else attachWires.push(w);
        }
        for (const w of prev) {
          if (!currentSet.has(w)) detachWires.push(w);
        }
      } else {
        for (const w of currentWires) attachWires.push(w);
      }

      // Synthetic dirty: unchanged components get full bitmask in Updated section
      if (unchangedWires.length > 0) {
        updateCount++;
        encoder.writeVarint(netId);
        encoder.writeU8(unchangedWires.length);
        for (const w of unchangedWires) {
          encoder.writeU8(w);
          const cf = ownedCompFields.find(c => c.wireId === w)!;
          const fullMask = (1 << cf.refs.length) - 1;
          encoder.writeU16(fullMask);
          for (const f of cf.refs) {
            const regField = registry.components[w].fields[f.fieldIdx];
            encoder.writeField(regField.type, em.get(eid, f.ref));
          }
        }
      }

      if (attachWires.length > 0) {
        attachedEntries.push({ netId, eid, wireIds: attachWires });
      }
      if (detachWires.length > 0) {
        detachedEntries.push({ netId, wireIds: detachWires });
      }

      prevOwnedPresence.set(netId, currentSet);
    }

    encoder.patchU16(updateCountOff, updateCount);

    // Attached section
    encoder.writeU16(attachedEntries.length);
    for (const entry of attachedEntries) {
      encoder.writeVarint(entry.netId);
      encoder.writeU8(entry.wireIds.length);
      for (const w of entry.wireIds) {
        encoder.writeU8(w);
        const cf = ownedCompFields.find(c => c.wireId === w)!;
        for (const f of cf.refs) {
          const regField = registry.components[w].fields[f.fieldIdx];
          encoder.writeField(regField.type, em.get(entry.eid, f.ref));
        }
      }
    }

    // Detached section
    encoder.writeU16(detachedEntries.length);
    for (const entry of detachedEntries) {
      encoder.writeVarint(entry.netId);
      encoder.writeU8(entry.wireIds.length);
      for (const w of entry.wireIds) {
        encoder.writeU8(w);
      }
    }

    (em as any).flushSnapshots();

    // Update prevOwnedPresence for newly tracked entities
    for (const [netId, eid] of netToEntity) {
      if (!prevOwnedPresence.has(netId)) {
        prevOwnedPresence.set(netId, new Set(getCurrentOwnedWireIds(eid)));
      }
    }

    // Send if there's any content (always has at least the empty sections)
    if (updateCount > 0 || attachedEntries.length > 0 || detachedEntries.length > 0) {
      ws.send(encoder.finish());
    }
  }

  // ── State application ──────────────────────────────────

  function applyFullState(msg: FullStateMessage) {
    // Clear all existing entities and mappings
    for (const id of em.getAllEntities()) {
      em.destroyEntity(id);
    }
    netToEntity.clear();
    prevOwnedPresence.clear();
    clientEntityArchId.clear();

    // Recreate entities with their components
    for (const [netId, compMap] of msg.entities) {
      const args: unknown[] = [];
      for (const [wireId, data] of compMap) {
        const reg = wireToComponent.get(wireId);
        if (reg) {
          args.push(reg.component, data);
        }
      }

      const localId = args.length > 0
        ? em.createEntityWith(...args, Networked)
        : em.createEntityWith(Networked);

      netToEntity.set(netId, localId);
    }
    _ownedDirty = true;
  }

  function applyDelta(msg: DeltaMessage) {
    // Apply creates
    for (const [netId, compMap] of msg.created) {
      const args: unknown[] = [];
      for (const [wireId, data] of compMap) {
        const reg = wireToComponent.get(wireId);
        if (reg) args.push(reg.component, data);
      }
      const localId = args.length > 0
        ? em.createEntityWith(...args, Networked)
        : em.createEntityWith(Networked);

      netToEntity.set(netId, localId);
    }

    // Apply destroys
    for (const netId of msg.destroyed) {
      const localId = netToEntity.get(netId);
      if (localId !== undefined) {
        em.destroyEntity(localId);
        netToEntity.delete(netId);
      }
    }

    // Apply updates
    for (const update of msg.updated) {
      const localId = netToEntity.get(update.netId);
      if (localId === undefined) continue;

      const reg = wireToComponent.get(update.componentWireId);
      if (!reg) continue;

      for (const [fieldName, value] of Object.entries(update.data)) {
        const fieldRef = (reg.component as any)[fieldName];
        if (fieldRef) {
          em.set(localId, fieldRef, value);
        }
      }
    }

    // Apply detaches first (in case of component swap — remove old before adding new)
    for (const entry of msg.detached) {
      const localId = netToEntity.get(entry.netId);
      if (localId === undefined) continue;

      const reg = wireToComponent.get(entry.componentWireId);
      if (!reg) continue;

      em.removeComponent(localId, reg.component);
    }

    // Apply attaches
    for (const entry of msg.attached) {
      const localId = netToEntity.get(entry.netId);
      if (localId === undefined) continue;

      const reg = wireToComponent.get(entry.componentWireId);
      if (!reg) continue;

      em.addComponent(localId, reg.component, entry.data);
    }
    _ownedDirty = true;
  }

  // ── Message buffer for tick()-based processing ─────────
  const pendingMessages: ArrayBuffer[] = [];
  const burstThreshold = options?.burstThreshold ?? 0;

  function requestFullResync() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const buf = new ArrayBuffer(1);
    new Uint8Array(buf)[0] = MSG_REQUEST_FULL;
    ws.send(buf);
  }

  function processPendingMessages() {
    if (pendingMessages.length === 0) return;

    // Count deltas in buffer
    if (burstThreshold > 0) {
      let deltaCount = 0;
      for (let i = 0; i < pendingMessages.length; i++) {
        if (new Uint8Array(pendingMessages[i])[0] === MSG_DELTA) deltaCount++;
      }

      if (deltaCount > burstThreshold) {
        // Discard all deltas, keep non-delta messages (custom app messages)
        for (let i = 0; i < pendingMessages.length; i++) {
          const firstByte = new Uint8Array(pendingMessages[i])[0];
          if (firstByte !== MSG_DELTA && firstByte !== MSG_FULL) {
            client.onMessage?.(pendingMessages[i]);
          }
        }
        pendingMessages.length = 0;
        requestFullResync();
        return;
      }
    }

    // Process normally
    for (let i = 0; i < pendingMessages.length; i++) {
      const buffer = pendingMessages[i];
      const firstByte = new Uint8Array(buffer)[0];

      if (firstByte !== MSG_FULL && firstByte !== MSG_DELTA) {
        client.onMessage?.(buffer);
        continue;
      }

      const msg = decoder.decode(buffer, registry);

      if (msg.type === MSG_FULL) {
        applyFullState(msg as FullStateMessage);
        (em as any).flushChanges();
      } else if (msg.type === MSG_DELTA) {
        applyDelta(msg as DeltaMessage);
        (em as any).flushChanges();
      }
    }
    pendingMessages.length = 0;
  }

  let _clientId = -1;
  let _reconnectToken = 0;  // 0 = no token (new client)

  // Cached owned entities — rebuilt after fullState/delta/clientId changes
  let _ownedCache: EntityId[] = [];
  let _ownedDirty = true;

  function rebuildOwnedCache() {
    if (!options?.ownerComponent) { _ownedCache = []; _ownedDirty = false; return; }
    const ref = options.ownerComponent.clientIdField;
    const result: EntityId[] = [];
    for (const eid of netToEntity.values()) {
      if (em.get(eid, ref) === _clientId) result.push(eid);
    }
    _ownedCache = result;
    _ownedDirty = false;
  }

  const client: NetClient = {
    onConnected: null,
    onDisconnected: null,
    onReconnected: null,
    onMessage: null,

    get connected() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },

    get clientId() {
      return _clientId;
    },

    get netToEntity(): ReadonlyMap<number, EntityId> {
      return netToEntity;
    },

    get ownedEntities(): EntityId[] {
      if (_ownedDirty) rebuildOwnedCache();
      return _ownedCache;
    },

    get reconnectToken() {
      return _reconnectToken;
    },
    set reconnectToken(value: number) {
      _reconnectToken = value;
    },

    send(data: ArrayBuffer) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },

    tick() {
      processPendingMessages();
      diffAndSendOwned();
    },

    connect(url: string) {
      if (ws) {
        ws.close();
      }

      const previousClientId = _clientId;

      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        // Send handshake: MSG_RECONNECT with stored token (0 = new client)
        const buf = new ArrayBuffer(5);
        const view = new DataView(buf);
        view.setUint8(0, MSG_RECONNECT);
        view.setUint32(1, _reconnectToken, true);
        ws!.send(buf);
      };

      ws.onmessage = (event: MessageEvent) => {
        const buffer = event.data as ArrayBuffer;
        const firstByte = new Uint8Array(buffer)[0];

        // MSG_CLIENT_ID is always handled immediately (connection handshake)
        if (firstByte === MSG_CLIENT_ID) {
          const view = new DataView(buffer);
          _clientId = view.getUint16(1, true);
          _reconnectToken = view.getUint32(3, true);
          // Reset tracking so client-owned diffs re-initialize after full state
          trackingInitialized = false;
          _ownedDirty = true;
          // Fire appropriate callback after receiving server confirmation
          if (_clientId === previousClientId && previousClientId !== -1) {
            client.onReconnected?.();
          } else {
            client.onConnected?.();
          }
          return;
        }

        // MSG_FULL is processed immediately (one-time sync, not subject to burst)
        if (firstByte === MSG_FULL) {
          const msg = decoder.decode(buffer, registry);
          applyFullState(msg as FullStateMessage);
          (em as any).flushChanges();
          return;
        }

        // Buffer MSG_DELTA and other messages for processing in tick()
        pendingMessages.push(buffer);
      };

      ws.onclose = () => {
        if (ws === null) return; // already handled by onerror
        ws = null;
        client.onDisconnected?.();
      };

      ws.onerror = () => {
        if (ws === null) return;
        const sock = ws;
        ws = null;
        client.onDisconnected?.();
        try { sock.close(); } catch { /* ignore */ }
      };
    },

    disconnect() {
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };

  return client;
}
