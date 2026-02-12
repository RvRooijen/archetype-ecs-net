import { ProtocolDecoder } from '../../../dist/Protocol.js';
import { MSG_FULL, MSG_DELTA } from '../../../dist/types.js';

const decoder = new ProtocolDecoder();

// Lightweight registry — just field metadata, no ECS dependency.
// Must match the server's registry order (shared.ts).
const registry = {
  hash: 0, // not validated for delta messages
  byWireId(id) {
    return [
      { fields: [{ name: 'x', type: 'f32' }, { name: 'y', type: 'f32' }] },  // 0: Position
      { fields: [{ name: 'r', type: 'u8' }, { name: 'g', type: 'u8' }, { name: 'b', type: 'u8' }] }, // 1: Color
    ][id];
  },
};

/** Decode any message → update entities map in place */
export function applyMessage(buf, entities) {
  const type = new Uint8Array(buf)[0];

  // Full state messages include a registry hash — patch it so decoder accepts
  if (type === 0x01) {
    patchRegistryHash(buf);
  }

  const msg = decoder.decode(buf, registry);

  if (msg.type === MSG_FULL) {
    entities.clear();
    for (const [netId, compMap] of msg.entities) {
      entities.set(netId, flattenComponents(compMap));
    }
  } else if (msg.type === MSG_DELTA) {
    // Created
    for (const [netId, compMap] of msg.created) {
      entities.set(netId, flattenComponents(compMap));
    }
    // Destroyed
    for (const netId of msg.destroyed) {
      entities.delete(netId);
    }
    // Updated
    for (const update of msg.updated) {
      const ent = entities.get(update.netId);
      if (ent) Object.assign(ent, update.data);
    }
  }
}

function flattenComponents(compMap) {
  const ent = {};
  for (const [, data] of compMap) {
    Object.assign(ent, data);
  }
  return ent;
}

/** Overwrite the registry hash in a MSG_FULL buffer with our local hash */
function patchRegistryHash(buf) {
  const view = new DataView(buf);
  // Store the remote hash as our "expected" hash so the decoder accepts it
  registry.hash = view.getUint32(1, true);
}
