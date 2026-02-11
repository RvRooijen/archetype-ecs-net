import type { EntityManager } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import { ProtocolDecoder } from './Protocol.js';
import { MSG_DELTA, MSG_FULL } from './types.js';
import type { DeltaMessage, FullStateMessage } from './types.js';

export interface NetClient {
  /** Connect to server */
  connect(url: string): void;
  /** Disconnect from server */
  disconnect(): void;
  /** Whether currently connected */
  readonly connected: boolean;
  /** Callbacks */
  onConnected: (() => void) | null;
  onDisconnected: (() => void) | null;
}

export function createNetClient(
  em: EntityManager,
  registry: ComponentRegistry,
): NetClient {
  const decoder = new ProtocolDecoder();
  let ws: WebSocket | null = null;

  // Map wireId → component def for fast lookup during apply
  const wireToComponent = new Map<number, (typeof registry.components)[number]>();
  for (const reg of registry.components) {
    wireToComponent.set(reg.wireId, reg);
  }

  function applyFullState(msg: FullStateMessage) {
    // Clear all existing entities
    for (const id of em.getAllEntities()) {
      em.destroyEntity(id);
    }

    // Recreate entities with their components
    for (const [entityId, compMap] of msg.entities) {
      // We need to create the entity with a specific ID.
      // archetype-ecs creates sequential IDs, so we create entities
      // and use createEntityWith for batch creation.
      // For now, we create + add components individually.
      // Note: this assumes server and client entity IDs are synchronized.
      const args: unknown[] = [];
      for (const [wireId, data] of compMap) {
        const reg = wireToComponent.get(wireId);
        if (reg) {
          args.push(reg.component, data);
        }
      }

      if (args.length > 0) {
        em.createEntityWith(...args);
      } else {
        em.createEntity();
      }
    }
  }

  function applyDelta(msg: DeltaMessage) {
    // Apply creates
    for (const [_entityId, compMap] of msg.created) {
      const args: unknown[] = [];
      for (const [wireId, data] of compMap) {
        const reg = wireToComponent.get(wireId);
        if (reg) args.push(reg.component, data);
      }
      if (args.length > 0) {
        em.createEntityWith(...args);
      } else {
        em.createEntity();
      }
    }

    // Apply destroys
    for (const entityId of msg.destroyed) {
      em.destroyEntity(entityId);
    }

    // Apply updates
    for (const update of msg.updated) {
      const reg = wireToComponent.get(update.componentWireId);
      if (!reg) continue;

      for (const [fieldName, value] of Object.entries(update.data)) {
        const fieldRef = (reg.component as any)[fieldName];
        if (fieldRef) {
          em.set(update.entityId, fieldRef, value);
        }
      }
    }
  }

  const client: NetClient = {
    onConnected: null,
    onDisconnected: null,

    get connected() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },

    connect(url: string) {
      if (ws) {
        ws.close();
      }

      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        client.onConnected?.();
      };

      ws.onmessage = (event: MessageEvent) => {
        const buffer = event.data as ArrayBuffer;
        const msg = decoder.decode(buffer, registry);

        if (msg.type === MSG_FULL) {
          applyFullState(msg as FullStateMessage);
        } else if (msg.type === MSG_DELTA) {
          applyDelta(msg as DeltaMessage);
        }
      };

      ws.onclose = () => {
        ws = null;
        client.onDisconnected?.();
      };

      ws.onerror = () => {
        ws?.close();
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
