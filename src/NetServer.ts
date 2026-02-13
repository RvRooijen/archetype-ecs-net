import type { EntityId, EntityManager, ComponentDef } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import { createSnapshotDiffer } from './DirtyTracker.js';
import type { InterestFilter } from './InterestManager.js';
import { createClientView } from './InterestManager.js';
import { ProtocolDecoder, ProtocolEncoder } from './Protocol.js';
import type { ClientDelta } from './InterestManager.js';
import { MSG_CLIENT_DELTA, MSG_CLIENT_ID, MSG_RECONNECT } from './types.js';
import type { ClientDeltaMessage, ClientId, NetworkConfig } from './types.js';

const EMPTY_KEY = '||||';
const DEFAULT_RECONNECT_WINDOW = 30_000;

function deltaKey(d: ClientDelta): string {
  if (d.enters.length === 0 && d.leaves.length === 0 && d.updates.length === 0 && d.attached.length === 0 && d.detached.length === 0) return EMPTY_KEY;
  // Sort copies — don't mutate the original arrays
  const e = d.enters.length > 1 ? d.enters.slice().sort((a, b) => a - b) : d.enters;
  const l = d.leaves.length > 1 ? d.leaves.slice().sort((a, b) => a - b) : d.leaves;
  const u = d.updates.length > 1 ? d.updates.slice().sort((a, b) => a - b) : d.updates;
  const at = d.attached.length > 1 ? d.attached.slice().sort((a, b) => a - b) : d.attached;
  const dt = d.detached.length > 1 ? d.detached.slice().sort((a, b) => a - b) : d.detached;
  return `${e.join(',')}|${l.join(',')}|${u.join(',')}|${at.join(',')}|${dt.join(',')}`;
}

// ── Transport interface ─────────────────────────────────

export interface ServerTransport {
  start(port: number, handlers: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  send(clientId: ClientId, data: ArrayBuffer): void;
  broadcast(data: ArrayBuffer): void;
}

export interface TransportHandlers {
  onOpen(clientId: ClientId): void;
  onClose(clientId: ClientId): void;
  onMessage(clientId: ClientId, data: ArrayBuffer): void;
}

// ── ws transport (default) ──────────────────────────────

export function createWsTransport(): ServerTransport {
  let wss: import('ws').WebSocketServer | null = null;
  const clients = new Map<ClientId, import('ws').WebSocket>();

  return {
    async start(port, handlers) {
      const { WebSocketServer } = await import('ws');
      let nextId: ClientId = 1;

      wss = new WebSocketServer({ port });

      await new Promise<void>((resolve, reject) => {
        wss!.once('listening', resolve);
        wss!.once('error', reject);
      });

      wss.on('connection', (ws) => {
        const clientId = nextId++;
        clients.set(clientId, ws);
        handlers.onOpen(clientId);

        ws.on('message', (data: Buffer) => {
          const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
          handlers.onMessage(clientId, ab);
        });

        ws.on('close', () => {
          clients.delete(clientId);
          handlers.onClose(clientId);
        });
      });
    },

    async stop() {
      if (wss) {
        for (const ws of clients.values()) ws.terminate();
        clients.clear();
        await new Promise<void>(r => wss!.close(() => r()));
        wss = null;
      }
    },

    send(clientId, data) {
      const ws = clients.get(clientId);
      if (ws && ws.readyState === 1) {
        ws.send(data);
      }
    },

    broadcast(data) {
      for (const ws of clients.values()) {
        if (ws.readyState === 1) ws.send(data);
      }
    },
  };
}

// ── NetServer ───────────────────────────────────────────

export interface NetServerOptions {
  /** Component used for entity ownership validation. If set, server checks that the
   *  sending client's ID matches the entity's owner field before applying client deltas. */
  ownerComponent?: { component: ComponentDef<any>; clientIdField: any };
}

export interface ComponentValidators {
  delta?:  (clientId: ClientId, entityId: EntityId, data: Record<string, unknown>) => boolean;
  attach?: (clientId: ClientId, entityId: EntityId, data: Record<string, unknown>) => boolean;
  detach?: (clientId: ClientId, entityId: EntityId) => boolean;
}

export interface NetServer {
  /** Start listening */
  start(): Promise<void>;
  /** Stop server and disconnect all clients */
  stop(): Promise<void>;
  /** Diff, encode, send. Without filter: broadcast to all. With filter: per-client interest. */
  tick(filter?: InterestFilter): void;
  /** Send a custom message to a specific client */
  send(clientId: ClientId, data: ArrayBuffer): void;
  /** Number of connected clients */
  readonly clientCount: number;
  /** Entity → netId mapping (assigned during tick) */
  readonly entityNetIds: ReadonlyMap<EntityId, number>;
  /** Register per-component validation for clientOwned updates. */
  validate(component: ComponentDef<any>, handlers: ComponentValidators): NetServer;
  /** Callbacks */
  onConnect: ((clientId: ClientId) => void) | null;
  onDisconnect: ((clientId: ClientId) => void) | null;
  onReconnect: ((clientId: ClientId) => void) | null;
  onMessage: ((clientId: ClientId, data: ArrayBuffer) => void) | null;
}

export function createNetServer(
  em: EntityManager,
  registry: ComponentRegistry,
  config: NetworkConfig,
  transport?: ServerTransport,
  options?: NetServerOptions,
): NetServer {
  const encoder = new ProtocolEncoder();
  const serverDecoder = new ProtocolDecoder();
  const differ = createSnapshotDiffer(em, registry);
  const tp = transport ?? createWsTransport();
  const validators = new Map<ComponentDef<any>, ComponentValidators>();

  const reconnectWindow = config.reconnectWindow ?? DEFAULT_RECONNECT_WINDOW;
  let stopped = false;

  // ── ID mapping ────────────────────────────────────────
  // Transport assigns its own IDs per WS connection. We maintain stable
  // logical IDs that survive reconnects.
  let nextLogicalId: ClientId = 1;
  const transportToLogical = new Map<ClientId, ClientId>();
  const logicalToTransport = new Map<ClientId, ClientId>();

  // Active logical clients (completed handshake)
  const activeClients = new Set<ClientId>();
  const clientViews = new Map<ClientId, ReturnType<typeof createClientView>>();

  // Pending handshake: transport connections that haven't sent MSG_RECONNECT yet
  const pendingHandshake = new Set<ClientId>(); // transport IDs

  // Pending reconnect: disconnected clients within grace period
  interface PendingReconnect {
    logicalId: ClientId;
    token: number;
    view: ReturnType<typeof createClientView>;
    timer: ReturnType<typeof setTimeout>;
  }
  const pendingByToken = new Map<number, PendingReconnect>();
  const tokenByLogical = new Map<ClientId, number>();

  // ── Token generation ──────────────────────────────────

  function generateToken(): number {
    let token: number;
    do {
      token = (Math.random() * 0xFFFFFFFF) >>> 0;
    } while (token === 0 || pendingByToken.has(token));
    return token;
  }

  // ── Send helpers ──────────────────────────────────────

  function sendToLogical(logicalId: ClientId, data: ArrayBuffer) {
    const transportId = logicalToTransport.get(logicalId);
    if (transportId !== undefined) tp.send(transportId, data);
  }

  function sendClientId(logicalId: ClientId, token: number) {
    const buf = new ArrayBuffer(7);
    const view = new DataView(buf);
    view.setUint8(0, MSG_CLIENT_ID);
    view.setUint16(1, logicalId, true);
    view.setUint32(3, token, true);
    sendToLogical(logicalId, buf);
  }

  function sendFullStateAndInit(logicalId: ClientId) {
    const fullState = encoder.encodeFullState(em, registry, differ.entityNetIds);
    sendToLogical(logicalId, fullState);
    const knownNetIds = new Set<number>(differ.entityNetIds.values());
    clientViews.get(logicalId)!.initKnown(knownNetIds);
  }

  // ── Handshake completion ──────────────────────────────

  function completeAsNewClient(transportId: ClientId) {
    const logicalId = nextLogicalId++;
    transportToLogical.set(transportId, logicalId);
    logicalToTransport.set(logicalId, transportId);
    activeClients.add(logicalId);
    clientViews.set(logicalId, createClientView());

    const token = generateToken();
    tokenByLogical.set(logicalId, token);

    sendClientId(logicalId, token);
    sendFullStateAndInit(logicalId);
    server.onConnect?.(logicalId);
  }

  function completeAsReconnect(transportId: ClientId, pending: PendingReconnect) {
    clearTimeout(pending.timer);
    pendingByToken.delete(pending.token);

    const logicalId = pending.logicalId;
    transportToLogical.set(transportId, logicalId);
    logicalToTransport.set(logicalId, transportId);
    activeClients.add(logicalId);
    clientViews.set(logicalId, pending.view);

    // Issue new token for next potential reconnect
    const newToken = generateToken();
    tokenByLogical.set(logicalId, newToken);

    sendClientId(logicalId, newToken);
    sendFullStateAndInit(logicalId);
    server.onReconnect?.(logicalId);
  }

  // ── Disconnect handling ───────────────────────────────

  function startGracePeriod(logicalId: ClientId) {
    if (stopped) return;

    const token = tokenByLogical.get(logicalId);
    const view = clientViews.get(logicalId);
    if (token === undefined || !view) {
      cleanupClient(logicalId);
      return;
    }

    activeClients.delete(logicalId);
    logicalToTransport.delete(logicalId);
    // Keep clientViews entry alive for reconnect

    if (reconnectWindow <= 0) {
      cleanupClient(logicalId);
      return;
    }

    const timer = setTimeout(() => {
      pendingByToken.delete(token);
      cleanupClient(logicalId);
    }, reconnectWindow);

    pendingByToken.set(token, { logicalId, token, view, timer });
  }

  function cleanupClient(logicalId: ClientId) {
    activeClients.delete(logicalId);
    clientViews.delete(logicalId);
    logicalToTransport.delete(logicalId);
    tokenByLogical.delete(logicalId);
    server.onDisconnect?.(logicalId);
  }

  // ── Client delta application ──────────────────────────

  function applyClientDelta(logicalId: ClientId, data: ArrayBuffer) {
    const msg = serverDecoder.decode(data, registry) as ClientDeltaMessage;

    for (const update of msg.updated) {
      const reg = registry.byWireId(update.componentWireId);
      if (!reg || !reg.clientOwned) continue;

      const entityId = differ.netIdToEntity.get(update.netId);
      if (entityId === undefined) continue;

      // Ownership validation
      if (options?.ownerComponent) {
        const oc = options.ownerComponent;
        const ownerValue = em.get(entityId, oc.clientIdField);
        if (ownerValue !== logicalId) continue;
      }

      // Merge partial delta with current ECS values so validators
      // always receive the complete component data, not just dirty fields.
      const mergedData: Record<string, unknown> = {};
      for (const field of reg.fields) {
        const fieldRef = (reg.component as any)[field.name];
        if (fieldRef) {
          mergedData[field.name] = field.name in update.data
            ? update.data[field.name]
            : em.get(entityId, fieldRef);
        }
      }

      // Per-component validation
      const deltaHandler = validators.get(reg.component);
      if (deltaHandler?.delta) {
        if (!deltaHandler.delta(logicalId, entityId, mergedData)) continue;
      }

      // Apply field values
      for (const [fieldName, value] of Object.entries(mergedData)) {
        const fieldRef = (reg.component as any)[fieldName];
        if (fieldRef) {
          em.set(entityId, fieldRef, value);
        }
      }
    }

    // Process attached components
    for (const entry of msg.attached) {
      const reg = registry.byWireId(entry.componentWireId);
      if (!reg || !reg.clientOwned) continue;

      const entityId = differ.netIdToEntity.get(entry.netId);
      if (entityId === undefined) continue;

      if (options?.ownerComponent) {
        const oc = options.ownerComponent;
        const ownerValue = em.get(entityId, oc.clientIdField);
        if (ownerValue !== logicalId) continue;
      }

      const attachHandler = validators.get(reg.component);
      if (attachHandler?.attach) {
        if (!attachHandler.attach(logicalId, entityId, entry.data)) continue;
      }

      em.addComponent(entityId, reg.component, entry.data);
    }

    // Process detached components
    for (const entry of msg.detached) {
      const reg = registry.byWireId(entry.componentWireId);
      if (!reg || !reg.clientOwned) continue;

      const entityId = differ.netIdToEntity.get(entry.netId);
      if (entityId === undefined) continue;

      if (options?.ownerComponent) {
        const oc = options.ownerComponent;
        const ownerValue = em.get(entityId, oc.clientIdField);
        if (ownerValue !== logicalId) continue;
      }

      const detachHandler = validators.get(reg.component);
      if (detachHandler?.detach) {
        if (!detachHandler.detach(logicalId, entityId)) continue;
      }

      em.removeComponent(entityId, reg.component);
    }
  }

  const server: NetServer = {
    onConnect: null,
    onDisconnect: null,
    onReconnect: null,
    onMessage: null,

    validate(component: ComponentDef<any>, handlers: ComponentValidators) {
      validators.set(component, handlers);
      return server;
    },

    get clientCount() {
      return activeClients.size;
    },

    get entityNetIds(): ReadonlyMap<EntityId, number> {
      return differ.entityNetIds;
    },

    send(clientId: ClientId, data: ArrayBuffer) {
      sendToLogical(clientId, data);
    },

    start() {
      return tp.start(config.port, {
        onOpen(transportId) {
          pendingHandshake.add(transportId);
        },

        onClose(transportId) {
          // If still pending handshake, just clean up
          if (pendingHandshake.delete(transportId)) {
            return;
          }

          const logicalId = transportToLogical.get(transportId);
          transportToLogical.delete(transportId);
          if (logicalId === undefined) return;

          startGracePeriod(logicalId);
        },

        onMessage(transportId, data) {
          // ── Handshake phase ──
          if (pendingHandshake.has(transportId)) {
            pendingHandshake.delete(transportId);

            const firstByte = new Uint8Array(data)[0];
            if (firstByte === MSG_RECONNECT && data.byteLength >= 5) {
              const token = new DataView(data).getUint32(1, true);
              const pending = token !== 0 ? pendingByToken.get(token) : undefined;
              if (pending) {
                completeAsReconnect(transportId, pending);
              } else {
                completeAsNewClient(transportId);
              }
            } else {
              // No handshake message — treat as new client, then process the message
              completeAsNewClient(transportId);
              // Fall through to handle the message below
              const logicalId = transportToLogical.get(transportId)!;
              if (firstByte === MSG_CLIENT_DELTA) {
                applyClientDelta(logicalId, data);
              } else {
                server.onMessage?.(logicalId, data);
              }
            }
            return;
          }

          // ── Normal message phase ──
          const logicalId = transportToLogical.get(transportId);
          if (logicalId === undefined) return;

          const firstByte = new Uint8Array(data)[0];
          if (firstByte === MSG_CLIENT_DELTA) {
            applyClientDelta(logicalId, data);
            return;
          }
          server.onMessage?.(logicalId, data);
        },
      });
    },

    async stop() {
      stopped = true;

      // Clear all grace period timers
      for (const pending of pendingByToken.values()) {
        clearTimeout(pending.timer);
      }
      pendingByToken.clear();

      await tp.stop();
      activeClients.clear();
      clientViews.clear();
      pendingHandshake.clear();
      transportToLogical.clear();
      logicalToTransport.clear();
      tokenByLogical.clear();
    },

    tick(filter?: InterestFilter) {
      if (!filter) {
        const buffer = differ.diffAndEncode(encoder);
        if (activeClients.size === 0) return;
        if (buffer.byteLength <= 11) return;
        for (const logicalId of activeClients) {
          sendToLogical(logicalId, buffer);
        }
        return;
      }

      const changeset = differ.computeChangeset();

      // Phase 1: compute all client deltas, group by identical content
      const groups = new Map<string, { delta: ClientDelta; clients: ClientId[] }>();
      const extraEnterNetIds = new Set<number>();

      for (const logicalId of activeClients) {
        const view = clientViews.get(logicalId);
        if (!view) continue;

        const interest = filter(logicalId);
        const delta = view.update(interest, changeset);

        const key = deltaKey(delta);
        if (key === EMPTY_KEY) continue;

        let group = groups.get(key);
        if (!group) {
          group = {
            delta: { enters: [...delta.enters], leaves: [...delta.leaves], updates: [...delta.updates], attached: [...delta.attached], detached: [...delta.detached] },
            clients: [],
          };
          groups.set(key, group);
        }
        group.clients.push(logicalId);

        for (const netId of delta.enters) {
          if (!changeset.createdSet.has(netId)) extraEnterNetIds.add(netId);
        }
      }

      if (groups.size === 0) {
        differ.flushSnapshots();
        return;
      }

      // Phase 2: pre-encode all entities once
      const cache = differ.preEncodeChangeset(encoder, changeset, extraEnterNetIds);

      // Phase 3: compose per group from cached slices, send to all clients
      for (const group of groups.values()) {
        const buffer = differ.composeFromCache(encoder, cache, group.delta);
        for (const logicalId of group.clients) {
          sendToLogical(logicalId, buffer);
        }
      }

      differ.flushSnapshots();
    },
  };

  return server;
}
