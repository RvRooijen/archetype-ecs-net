import type { EntityManager } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import { createSnapshotDiffer } from './DirtyTracker.js';
import { ProtocolEncoder } from './Protocol.js';
import type { ClientId, NetworkConfig } from './types.js';

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
  /** Snapshot-diff Networked entities, encode delta, broadcast. Call once per tick. */
  tick(): void;
  /** Number of connected clients */
  readonly clientCount: number;
  /** Callbacks */
  onConnect: ((clientId: ClientId) => void) | null;
  onDisconnect: ((clientId: ClientId) => void) | null;
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
  let connectedClients = 0;

  const server: NetServer = {
    onConnect: null,
    onDisconnect: null,

    get clientCount() {
      return connectedClients;
    },

    start() {
      return tp.start(config.port, {
        onOpen(clientId) {
          connectedClients++;
          const fullState = encoder.encodeFullState(em, registry, differ.entityNetIds);
          tp.send(clientId, fullState);
          server.onConnect?.(clientId);
        },

        onClose(clientId) {
          connectedClients--;
          server.onDisconnect?.(clientId);
        },

        onMessage(_clientId, _data) {
          // Client → server messages not handled in v0.1.0
        },
      });
    },

    async stop() {
      await tp.stop();
      connectedClients = 0;
    },

    tick() {
      const delta = differ.diff();

      if (connectedClients === 0) return;

      if (delta.created.size === 0 && delta.destroyed.length === 0 && delta.updated.size === 0) {
        return;
      }

      const buffer = encoder.encodeDelta(delta, em, registry, differ.netIdToEntity);
      tp.broadcast(buffer);
    },
  };

  return server;
}
