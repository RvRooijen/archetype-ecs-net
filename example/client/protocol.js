// Uses the package's ProtocolDecoder instead of an inline copy.
// Serve from project root so the dist/ imports resolve.
import { ProtocolDecoder } from '../../dist/Protocol.js';
import { MSG_FULL } from '../../dist/types.js';

const decoder = new ProtocolDecoder();

// Lightweight registry — just field metadata, no ECS dependency.
// Must match the server's registry order (shared.ts).
const registry = {
  byWireId(id) {
    return [
      { fields: [{ name: 'x', type: 'i16' }, { name: 'y', type: 'i16' }] },             // 0: Position
      { fields: [{ name: 'kind', type: 'u8' }] },                                         // 1: EntityType
      { fields: [{ name: 'current', type: 'i16' }, { name: 'max', type: 'i16' }] },       // 2: Health
      { fields: [{ name: 'variant', type: 'u8' }] },                                      // 3: Appearance
    ][id];
  },
};

/** Decode MSG_FULL buffer → Map<netId, {x, y, kind, hp, maxHp, variant}> */
export function decodeFullState(buf) {
  const msg = decoder.decode(buf, registry);
  if (msg.type !== MSG_FULL) return new Map();

  const result = new Map();
  for (const [netId, compMap] of msg.entities) {
    const ent = { x: 0, y: 0, kind: 0, hp: 0, maxHp: 0, variant: 0 };
    const pos = compMap.get(0);
    if (pos) { ent.x = pos.x; ent.y = pos.y; }
    const etype = compMap.get(1);
    if (etype) { ent.kind = etype.kind; }
    const hp = compMap.get(2);
    if (hp) { ent.hp = hp.current; ent.maxHp = hp.max; }
    const app = compMap.get(3);
    if (app) { ent.variant = app.variant; }
    result.set(netId, ent);
  }
  return result;
}
