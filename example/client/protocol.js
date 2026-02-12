// Uses the package's ProtocolDecoder instead of an inline copy.
// Serve from project root so the dist/ imports resolve.
import { ProtocolDecoder } from '../../dist/Protocol.js';
import { MSG_FULL, MSG_DELTA } from '../../dist/types.js';

const decoder = new ProtocolDecoder();

// Lightweight registry — just field metadata, no ECS dependency.
// Must match the server's registry order (shared.ts).
const components = [
  { name: 'Position',   fields: [{ name: 'x', type: 'i16' }, { name: 'y', type: 'i16' }] },
  { name: 'EntityType', fields: [{ name: 'kind', type: 'u8' }] },
  { name: 'Health',     fields: [{ name: 'current', type: 'i16' }, { name: 'max', type: 'i16' }] },
  { name: 'Appearance', fields: [{ name: 'variant', type: 'u8' }] },
];

// FNV-1a hash — must match server's ComponentRegistry hash
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

let schemaStr = '';
for (const c of components) {
  schemaStr += c.name + ':';
  for (const f of c.fields) schemaStr += f.name + ':' + f.type + ',';
  schemaStr += ';';
}

const registry = {
  hash: fnv1a(schemaStr),
  byWireId(id) { return components[id]; },
};

function entityFromCompMap(compMap) {
  const ent = { x: 0, y: 0, kind: 0, hp: 0, maxHp: 0, variant: 0 };
  const pos = compMap.get(0);
  if (pos) { ent.x = pos.x; ent.y = pos.y; }
  const etype = compMap.get(1);
  if (etype) { ent.kind = etype.kind; }
  const hp = compMap.get(2);
  if (hp) { ent.hp = hp.current; ent.maxHp = hp.max; }
  const app = compMap.get(3);
  if (app) { ent.variant = app.variant; }
  return ent;
}

/** Decode MSG_FULL buffer → Map<netId, {x, y, kind, hp, maxHp, variant}> */
export function decodeFullState(buf) {
  const msg = decoder.decode(buf, registry);
  if (msg.type !== MSG_FULL) return new Map();

  const result = new Map();
  for (const [netId, compMap] of msg.entities) {
    result.set(netId, entityFromCompMap(compMap));
  }
  return result;
}

/** Apply MSG_DELTA buffer to existing entity map (mutates in place) */
export function applyDelta(buf, entities) {
  const msg = decoder.decode(buf, registry);
  if (msg.type !== MSG_DELTA) return;

  // Created entities (or view-enters with full data)
  for (const [netId, compMap] of msg.created) {
    entities.set(netId, entityFromCompMap(compMap));
  }

  // Destroyed entities (or view-leaves)
  for (const netId of msg.destroyed) {
    entities.delete(netId);
  }

  // Updated entities (partial field changes)
  for (const upd of msg.updated) {
    const ent = entities.get(upd.netId);
    if (!ent) continue;
    if (upd.componentWireId === 0) { // Position
      if ('x' in upd.data) ent.x = upd.data.x;
      if ('y' in upd.data) ent.y = upd.data.y;
    } else if (upd.componentWireId === 1) { // EntityType
      if ('kind' in upd.data) ent.kind = upd.data.kind;
    } else if (upd.componentWireId === 2) { // Health
      if ('current' in upd.data) ent.hp = upd.data.current;
      if ('max' in upd.data) ent.maxHp = upd.data.max;
    } else if (upd.componentWireId === 3) { // Appearance
      if ('variant' in upd.data) ent.variant = upd.data.variant;
    }
  }
}
