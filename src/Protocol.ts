import type { EntityId, EntityManager } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import type { DeltaMessage, FieldInfo, FullStateMessage, NetMessage, WireType } from './types.js';
import { MSG_DELTA, MSG_FULL } from './types.js';

// ── Encoder ─────────────────────────────────────────────

const INITIAL_BUFFER_SIZE = 4096;
const textEncoder = new TextEncoder();

export class ProtocolEncoder {
  private buf: ArrayBuffer;
  private view: DataView;
  private offset = 0;

  constructor(initialSize = INITIAL_BUFFER_SIZE) {
    this.buf = new ArrayBuffer(initialSize);
    this.view = new DataView(this.buf);
  }

  private ensure(bytes: number) {
    if (this.offset + bytes <= this.buf.byteLength) return;
    let newSize = this.buf.byteLength * 2;
    while (newSize < this.offset + bytes) newSize *= 2;
    const newBuf = new ArrayBuffer(newSize);
    new Uint8Array(newBuf).set(new Uint8Array(this.buf));
    this.buf = newBuf;
    this.view = new DataView(this.buf);
  }

  writeU8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
  }

  writeU16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }

  writeU32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
  }

  private writeF32(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
  }

  private writeF64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
  }

  private writeI8(v: number) {
    this.ensure(1);
    this.view.setInt8(this.offset, v);
    this.offset += 1;
  }

  private writeI16(v: number) {
    this.ensure(2);
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
  }

  private writeI32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.offset, v, true);
    this.offset += 4;
  }

  private writeString(s: string) {
    const encoded = textEncoder.encode(s);
    this.writeU16(encoded.byteLength);
    this.ensure(encoded.byteLength);
    new Uint8Array(this.buf, this.offset, encoded.byteLength).set(encoded);
    this.offset += encoded.byteLength;
  }

  /** Reserve a u8 slot, returns the offset for backpatching */
  reserveU8(): number {
    const off = this.offset;
    this.writeU8(0);
    return off;
  }

  /** Reserve a u16 slot, returns the offset for backpatching */
  reserveU16(): number {
    const off = this.offset;
    this.writeU16(0);
    return off;
  }

  /** Write a u8 value at a previously reserved offset */
  patchU8(off: number, v: number) {
    this.view.setUint8(off, v);
  }

  /** Write a u16 value at a previously reserved offset */
  patchU16(off: number, v: number) {
    this.view.setUint16(off, v, true);
  }

  writeVarint(v: number) {
    if (v < 0 || v > 0xFFFFFFFF) throw new RangeError(`Varint out of range: ${v}`);
    while (v >= 0x80) {
      this.writeU8((v & 0x7F) | 0x80);
      v >>>= 7;
    }
    this.writeU8(v);
  }

  writeField(type: WireType, value: unknown) {
    switch (type) {
      case 'f32': this.writeF32(value as number); break;
      case 'f64': this.writeF64(value as number); break;
      case 'i8': this.writeI8(value as number); break;
      case 'i16': this.writeI16(value as number); break;
      case 'i32': this.writeI32(value as number); break;
      case 'u8': this.writeU8(value as number); break;
      case 'u16': this.writeU16(value as number); break;
      case 'u32': this.writeU32(value as number); break;
      case 'string': this.writeString(value as string); break;
    }
  }

  private writeComponentData(fields: FieldInfo[], data: Record<string, unknown>) {
    for (const field of fields) {
      this.writeField(field.type, data[field.name]);
    }
  }

  /** Reset write position for reuse (no reallocation) */
  reset() {
    this.offset = 0;
  }

  /** Returns a trimmed copy of the written bytes */
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.offset);
  }

  // ── Full state encoding ─────────────────────────────

  encodeFullState(
    em: EntityManager,
    registry: ComponentRegistry,
    entityNetIds: ReadonlyMap<EntityId, number>,
  ): ArrayBuffer {
    this.reset();
    this.writeU8(MSG_FULL);
    this.writeU32(registry.hash);

    this.writeU16(entityNetIds.size);

    for (const [entityId, netId] of entityNetIds) {
      this.writeVarint(netId);

      // Count components this entity has
      const comps: { reg: (typeof registry.components)[number]; data: Record<string, unknown> }[] = [];
      for (const reg of registry.components) {
        if (em.hasComponent(entityId, reg.component)) {
          const data = em.getComponent(entityId, reg.component);
          if (data) comps.push({ reg, data: data as Record<string, unknown> });
        }
      }

      this.writeU8(comps.length);
      for (const { reg, data } of comps) {
        this.writeU8(reg.wireId);
        this.writeComponentData(reg.fields, data);
      }
    }

    return this.finish();
  }

}

// ── Decoder ─────────────────────────────────────────────

const textDecoder = new TextDecoder();

export class ProtocolDecoder {
  private view!: DataView;
  private bytes!: Uint8Array;
  private offset = 0;

  private readU8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  private readU16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  private readU32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  private readF32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  private readF64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  private readI8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  private readI16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  private readI32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  private readString(): string {
    const len = this.readU16();
    const str = textDecoder.decode(this.bytes.subarray(this.offset, this.offset + len));
    this.offset += len;
    return str;
  }

  private readVarint(): number {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      if (shift >= 35) throw new Error('Varint too long (corrupt data or >5 bytes)');
      b = this.readU8();
      v |= (b & 0x7F) << shift;
      shift += 7;
    } while (b >= 0x80);
    return v >>> 0;
  }

  private readField(type: WireType): unknown {
    switch (type) {
      case 'f32': return this.readF32();
      case 'f64': return this.readF64();
      case 'i8': return this.readI8();
      case 'i16': return this.readI16();
      case 'i32': return this.readI32();
      case 'u8': return this.readU8();
      case 'u16': return this.readU16();
      case 'u32': return this.readU32();
      case 'string': return this.readString();
    }
  }

  private readComponentData(fields: FieldInfo[]): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of fields) {
      data[field.name] = this.readField(field.type);
    }
    return data;
  }

  decode(buffer: ArrayBuffer, registry: ComponentRegistry): NetMessage {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;

    const msgType = this.readU8();

    if (msgType === MSG_FULL) {
      return this.decodeFullState(registry);
    } else if (msgType === MSG_DELTA) {
      return this.decodeDelta(registry);
    }

    throw new Error(`Unknown message type: 0x${msgType.toString(16)}`);
  }

  private decodeFullState(registry: ComponentRegistry): FullStateMessage {
    const remoteHash = this.readU32();
    if (remoteHash !== registry.hash) {
      throw new Error(
        `Registry mismatch: server hash 0x${remoteHash.toString(16)} !== client hash 0x${registry.hash.toString(16)}. ` +
        `Ensure server and client use identical component registrations (same names, fields, types, and order).`
      );
    }
    const entityCount = this.readU16();
    const entities = new Map<number, Map<number, Record<string, unknown>>>();

    for (let e = 0; e < entityCount; e++) {
      const netId = this.readVarint();
      const compCount = this.readU8();
      const compMap = new Map<number, Record<string, unknown>>();

      for (let c = 0; c < compCount; c++) {
        const wireId = this.readU8();
        const reg = registry.byWireId(wireId);
        if (!reg) throw new Error(`Unknown wire ID: ${wireId}`);
        compMap.set(wireId, this.readComponentData(reg.fields));
      }

      entities.set(netId, compMap);
    }

    return { type: MSG_FULL, entities };
  }

  private decodeDelta(registry: ComponentRegistry): DeltaMessage {
    // Created
    const createdCount = this.readU16();
    const created = new Map<number, Map<number, Record<string, unknown>>>();
    for (let i = 0; i < createdCount; i++) {
      const netId = this.readVarint();
      const compCount = this.readU8();
      const compMap = new Map<number, Record<string, unknown>>();
      for (let c = 0; c < compCount; c++) {
        const wireId = this.readU8();
        const reg = registry.byWireId(wireId);
        if (!reg) throw new Error(`Unknown wire ID: ${wireId}`);
        compMap.set(wireId, this.readComponentData(reg.fields));
      }
      created.set(netId, compMap);
    }

    // Destroyed
    const destroyedCount = this.readU16();
    const destroyed: number[] = [];
    for (let i = 0; i < destroyedCount; i++) {
      destroyed.push(this.readVarint());
    }

    // Updated (grouped by entity)
    const updatedEntityCount = this.readU16();
    const updated: DeltaMessage['updated'] = [];
    for (let i = 0; i < updatedEntityCount; i++) {
      const netId = this.readVarint();
      const compCount = this.readU8();
      for (let c = 0; c < compCount; c++) {
        const wireId = this.readU8();
        const fieldMask = this.readU16();
        const reg = registry.byWireId(wireId);
        if (!reg) throw new Error(`Unknown wire ID: ${wireId}`);

        const validMask = (1 << reg.fields.length) - 1;
        if (fieldMask & ~validMask) {
          throw new Error(
            `Invalid field mask 0x${fieldMask.toString(16)} for wire ID ${wireId}: ` +
            `has bits set beyond ${reg.fields.length} fields`
          );
        }
        const data: Record<string, unknown> = {};
        for (let f = 0; f < reg.fields.length; f++) {
          if (fieldMask & (1 << f)) {
            data[reg.fields[f].name] = this.readField(reg.fields[f].type);
          }
        }

        updated.push({ netId, componentWireId: wireId, fieldMask, data });
      }
    }

    return { type: MSG_DELTA, created, destroyed, updated };
  }
}

// ── Convenience functions ───────────────────────────────

const sharedEncoder = new ProtocolEncoder();
const sharedDecoder = new ProtocolDecoder();

export function encodeFullState(
  em: EntityManager,
  registry: ComponentRegistry,
  entityNetIds: ReadonlyMap<EntityId, number>,
): ArrayBuffer {
  return sharedEncoder.encodeFullState(em, registry, entityNetIds);
}

export function decode(buffer: ArrayBuffer, registry: ComponentRegistry): NetMessage {
  return sharedDecoder.decode(buffer, registry);
}
