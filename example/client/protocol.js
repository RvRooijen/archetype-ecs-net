// Inline binary decoder for MSG_FULL (0x01).
// Matches the wire format from archetype-ecs-net without importing the library.

function readVarint(view, o) {
  let v = 0, shift = 0, b;
  do { b = view.getUint8(o.p++); v |= (b & 0x7F) << shift; shift += 7; } while (b >= 0x80);
  return v >>> 0;
}

export function decodeFullState(buf) {
  const view = new DataView(buf);
  const o = { p: 1 }; // skip msg type byte
  const count = view.getUint16(o.p, true); o.p += 2;
  const result = new Map();

  for (let e = 0; e < count; e++) {
    const netId = readVarint(view, o);
    const compCount = view.getUint8(o.p++);
    const ent = { x: 0, y: 0, kind: 0, hp: 0, maxHp: 0, variant: 0 };

    for (let c = 0; c < compCount; c++) {
      const wireId = view.getUint8(o.p++);
      switch (wireId) {
        case 0: // Position: i16 x, i16 y
          ent.x = view.getInt16(o.p, true); o.p += 2;
          ent.y = view.getInt16(o.p, true); o.p += 2;
          break;
        case 1: // EntityType: u8 kind
          ent.kind = view.getUint8(o.p++);
          break;
        case 2: // Health: i16 current, i16 max
          ent.hp = view.getInt16(o.p, true); o.p += 2;
          ent.maxHp = view.getInt16(o.p, true); o.p += 2;
          break;
        case 3: // Appearance: u8 variant
          ent.variant = view.getUint8(o.p++);
          break;
      }
    }
    result.set(netId, ent);
  }
  return result;
}
