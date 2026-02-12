import type { EntityId, EntityManager } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import { createSnapshotDiffer } from './DirtyTracker.js';
import type { InterestFilter } from './InterestManager.js';
import { createClientView } from './InterestManager.js';
import { ProtocolEncoder } from './Protocol.js';
import type { ClientDelta } from './InterestManager.js';
import type { ClientId, NetworkConfig } from './types.js';

const EMPTY_KEY = '||';

function deltaKey(d: ClientDelta): string {
  if (d.enters.length === 0 && d.leaves.length === 0 && d.updates.length === 0) return EMPTY_KEY;
  // Sort copies — don't mutate the original arrays
  const e = d.enters.length > 1 ? d.enters.slice().sort((a, b) => a - b) : d.enters;
  const l = d.leaves.length > 1 ? d.leaves.slice().sort((a, b) => a - b) : d.leaves;
  const u = d.updates.length > 1 ? d.updates.slice().sort((a, b) => a - b) : d.updates;
  return `${e.join(',')}|${l.join(',')}|${u.join(',')}`;
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
  /** Callbacks */
  onConnect: ((clientId: ClientId) => void) | null;
  onDisconnect: ((clientId: ClientId) => void) | null;
  onMessage: ((clientId: ClientId, data: ArrayBuffer) => void) | null;
}

export function createNetServer(
  em: EntityManager,
  registry: ComponentRegistry,
  config: NetworkConfig,
  transport?: ServerTransport,
): NetServer {
  const encoder = new ProtocolEncoder();
  const differ = createSnapshotDiffer(em, registry);
  const tp = transport ?? createWsTransport();
  const clientIds = new Set<ClientId>();
  const clientViews = new Map<ClientId, ReturnType<typeof createClientView>>();

  const server: NetServer = {
    onConnect: null,
    onDisconnect: null,
    onMessage: null,

    get clientCount() {
      return clientIds.size;
    },

    get entityNetIds(): ReadonlyMap<EntityId, number> {
      return differ.entityNetIds;
    },

    send(clientId: ClientId, data: ArrayBuffer) {
      tp.send(clientId, data);
    },

    start() {
      return tp.start(config.port, {
        onOpen(clientId) {
          clientIds.add(clientId);
          clientViews.set(clientId, createClientView());
          const fullState = encoder.encodeFullState(em, registry, differ.entityNetIds);
          tp.send(clientId, fullState);
          // Initialize the client view's known set to match the full state we just sent
          const knownNetIds = new Set<number>(differ.entityNetIds.values());
          clientViews.get(clientId)!.initKnown(knownNetIds);
          server.onConnect?.(clientId);
        },

        onClose(clientId) {
          clientIds.delete(clientId);
          clientViews.delete(clientId);
          server.onDisconnect?.(clientId);
        },

        onMessage(clientId, data) {
          server.onMessage?.(clientId, data);
        },
      });
    },

    async stop() {
      await tp.stop();
      clientIds.clear();
      clientViews.clear();
    },

    tick(filter?: InterestFilter) {
      if (!filter) {
        const buffer = differ.diffAndEncode(encoder);
        if (clientIds.size === 0) return;
        if (buffer.byteLength <= 7) return;
        tp.broadcast(buffer);
        return;
      }


      const changeset = differ.computeChangeset();

      // Phase 1: compute all client deltas, group by identical content
      const groups = new Map<string, { delta: ClientDelta; clients: ClientId[] }>();
      const extraEnterNetIds = new Set<number>();

      for (const clientId of clientIds) {
        const view = clientViews.get(clientId);
        if (!view) continue;

        const interest = filter(clientId);
        const delta = view.update(interest, changeset);

        const key = deltaKey(delta);
        if (key === EMPTY_KEY) continue;

        let group = groups.get(key);
        if (!group) {
          // Copy arrays — clientView reuses them on next update() call
          group = {
            delta: { enters: [...delta.enters], leaves: [...delta.leaves], updates: [...delta.updates] },
            clients: [],
          };
          groups.set(key, group);
        }
        group.clients.push(clientId);

        // Collect view-enters that aren't global creates (need pre-encoding)
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
        for (const clientId of group.clients) {
          tp.send(clientId, buffer);
        }
      }

      differ.flushSnapshots();
    },
  };

  return server;
}
