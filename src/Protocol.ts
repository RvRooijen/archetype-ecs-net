import type { EntityId, EntityManager } from 'archetype-ecs';
import type { ComponentRegistry } from './ComponentRegistry.js';
import type { Delta, DeltaMessage, FieldInfo, FullStateMessage, NetMessage, WireType } from './types.js';
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

  private writeU8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
  }

  private writeU16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }

  private writeU32(v: number) {
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

  private writeField(type: WireType, value: unknown) {
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

  encodeFullState(em: EntityManager, registry: ComponentRegistry): ArrayBuffer {
    this.reset();
    this.writeU8(MSG_FULL);

    const entities = em.getAllEntities();
    this.writeU16(entities.length);

    for (const entityId of entities) {
      this.writeU32(entityId);

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

  // ── Delta encoding ──────────────────────────────────

  encodeDelta(delta: Delta, em: EntityManager, registry: ComponentRegistry): ArrayBuffer {
    this.reset();
    this.writeU8(MSG_DELTA);

    // Created entities
    this.writeU16(delta.created.size);
    for (const [entityId, compMap] of delta.created) {
      this.writeU32(entityId);
      this.writeU8(compMap.size);
      for (const [wireId, data] of compMap) {
        const reg = registry.byWireId(wireId);
        if (!reg) continue;
        this.writeU8(wireId);
        this.writeComponentData(reg.fields, data);
      }
    }

    // Destroyed entities
    this.writeU16(delta.destroyed.size);
    for (const entityId of delta.destroyed) {
      this.writeU32(entityId);
    }

    // Updated fields
    let updateCount = 0;
    for (const dirtyFields of delta.updated.values()) {
      updateCount += dirtyFields.length;
    }
    this.writeU16(updateCount);

    for (const [entityId, dirtyFields] of delta.updated) {
      for (const dirty of dirtyFields) {
        const reg = registry.byWireId(dirty.componentWireId);
        if (!reg) continue;

        this.writeU32(entityId);
        this.writeU8(dirty.componentWireId);

        // Build field bitmask
        let mask = 0;
        for (const fieldName of dirty.fields) {
          const idx = reg.fields.findIndex(f => f.name === fieldName);
          if (idx >= 0) mask |= (1 << idx);
        }
        this.writeU8(mask);

        // Write only dirty field values
        for (let i = 0; i < reg.fields.length; i++) {
          if (mask & (1 << i)) {
            const field = reg.fields[i];
            const value = em.get(entityId, (reg.component as any)[field.name]);
            this.writeField(field.type, value);
          }
        }
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
    const entityCount = this.readU16();
    const entities = new Map<EntityId, Map<number, Record<string, unknown>>>();

    for (let e = 0; e < entityCount; e++) {
      const entityId = this.readU32();
      const compCount = this.readU8();
      const compMap = new Map<number, Record<string, unknown>>();

      for (let c = 0; c < compCount; c++) {
        const wireId = this.readU8();
        const reg = registry.byWireId(wireId);
        if (!reg) throw new Error(`Unknown wire ID: ${wireId}`);
        compMap.set(wireId, this.readComponentData(reg.fields));
      }

      entities.set(entityId, compMap);
    }

    return { type: MSG_FULL, entities };
  }

  private decodeDelta(registry: ComponentRegistry): DeltaMessage {
    // Created
    const createdCount = this.readU16();
    const created = new Map<EntityId, Map<number, Record<string, unknown>>>();
    for (let i = 0; i < createdCount; i++) {
      const entityId = this.readU32();
      const compCount = this.readU8();
      const compMap = new Map<number, Record<string, unknown>>();
      for (let c = 0; c < compCount; c++) {
        const wireId = this.readU8();
        const reg = registry.byWireId(wireId);
        if (!reg) throw new Error(`Unknown wire ID: ${wireId}`);
        compMap.set(wireId, this.readComponentData(reg.fields));
      }
      created.set(entityId, compMap);
    }

    // Destroyed
    const destroyedCount = this.readU16();
    const destroyed: EntityId[] = [];
    for (let i = 0; i < destroyedCount; i++) {
      destroyed.push(this.readU32());
    }

    // Updated
    const updatedCount = this.readU16();
    const updated: DeltaMessage['updated'] = [];
    for (let i = 0; i < updatedCount; i++) {
      const entityId = this.readU32();
      const wireId = this.readU8();
      const fieldMask = this.readU8();
      const reg = registry.byWireId(wireId);
      if (!reg) throw new Error(`Unknown wire ID: ${wireId}`);

      const data: Record<string, unknown> = {};
      for (let f = 0; f < reg.fields.length; f++) {
        if (fieldMask & (1 << f)) {
          data[reg.fields[f].name] = this.readField(reg.fields[f].type);
        }
      }

      updated.push({ entityId, componentWireId: wireId, fieldMask, data });
    }

    return { type: MSG_DELTA, created, destroyed, updated };
  }
}

// ── Convenience functions ───────────────────────────────

const sharedEncoder = new ProtocolEncoder();
const sharedDecoder = new ProtocolDecoder();

export function encodeFullState(em: EntityManager, registry: ComponentRegistry): ArrayBuffer {
  return sharedEncoder.encodeFullState(em, registry);
}

export function encodeDelta(delta: Delta, em: EntityManager, registry: ComponentRegistry): ArrayBuffer {
  return sharedEncoder.encodeDelta(delta, em, registry);
}

export function decode(buffer: ArrayBuffer, registry: ComponentRegistry): NetMessage {
  return sharedDecoder.decode(buffer, registry);
}
