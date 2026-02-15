import { componentSchemas } from 'archetype-ecs';
import type { ComponentRegistration, FieldInfo, RegisteredComponent, WireType } from './types.js';

// Maps TypedArray constructors back to wire type strings
const CTOR_TO_TYPE = new Map<Function, WireType>([
  [Float32Array, 'f32'],
  [Float64Array, 'f64'],
  [Int8Array, 'i8'],
  [Int16Array, 'i16'],
  [Int32Array, 'i32'],
  [Uint8Array, 'u8'],
  [Uint16Array, 'u16'],
  [Uint32Array, 'u32'],
  [Array, 'string'],
]);

const TYPE_BYTE_SIZE: Record<WireType, number> = {
  f32: 4, f64: 8,
  i8: 1, i16: 2, i32: 4,
  u8: 1, u16: 2, u32: 4,
  string: 0, // variable length
};

export interface ComponentRegistry {
  /** All registered components in wire ID order */
  readonly components: readonly RegisteredComponent[];
  /** Deterministic 32-bit hash of the registry schema (names + field names + types + ownership) */
  readonly hash: number;
  /** Wire IDs of client-owned components */
  readonly clientOwnedWireIds: ReadonlySet<number>;
  /** Look up by wire ID */
  byWireId(id: number): RegisteredComponent | undefined;
  /** Look up by component symbol */
  bySymbol(sym: symbol): RegisteredComponent | undefined;
  /** Look up by wire name */
  byName(name: string): RegisteredComponent | undefined;
}

/** Simple FNV-1a 32-bit hash */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createComponentRegistry(registrations: ComponentRegistration[]): ComponentRegistry {
  if (registrations.length > 255) {
    throw new Error(`Max 255 networked components (got ${registrations.length})`);
  }

  const components: RegisteredComponent[] = [];
  const byWireIdMap = new Map<number, RegisteredComponent>();
  const bySymbolMap = new Map<symbol, RegisteredComponent>();
  const byNameMap = new Map<string, RegisteredComponent>();

  for (let i = 0; i < registrations.length; i++) {
    const reg = registrations[i];
    const sym = reg.component._sym;
    const schema = componentSchemas.get(sym);

    const fields: FieldInfo[] = [];
    if (schema) {
      for (const [fieldName, spec] of Object.entries(schema)) {
        let Ctor: Function;
        let arraySize = 0;
        if (Array.isArray(spec)) {
          // Fixed-size array: [Uint16Array, 28]
          Ctor = spec[0];
          arraySize = spec[1];
        } else {
          Ctor = spec;
        }
        const wireType = CTOR_TO_TYPE.get(Ctor);
        if (!wireType) throw new Error(`Unknown constructor for field "${fieldName}" in "${reg.name}"`);
        fields.push({
          name: fieldName,
          type: wireType,
          byteSize: TYPE_BYTE_SIZE[wireType],
          arraySize,
        });
      }
    }

    if (fields.length > 16) {
      throw new Error(`Component "${reg.name}" has ${fields.length} fields (max 16 for u16 field bitmask)`);
    }

    const entry: RegisteredComponent = {
      wireId: i,
      name: reg.name,
      component: reg.component,
      fields,
      clientOwned: reg.clientOwned === true,
    };

    components.push(entry);
    byWireIdMap.set(i, entry);
    bySymbolMap.set(sym, entry);
    byNameMap.set(reg.name, entry);
  }

  // Validate wireIds are sequential (defensive against future refactoring)
  for (let i = 0; i < components.length; i++) {
    if (components[i].wireId !== i) {
      throw new Error(`Internal error: wireId mismatch at index ${i} (expected ${i}, got ${components[i].wireId})`);
    }
  }

  // Build deterministic schema fingerprint: "name:field1:type1,...,C|S;..."
  let schemaStr = '';
  const clientOwnedSet = new Set<number>();
  for (const c of components) {
    schemaStr += c.name + ':';
    for (const f of c.fields) schemaStr += f.name + ':' + f.type + (f.arraySize ? '[' + f.arraySize + ']' : '') + ',';
    schemaStr += c.clientOwned ? 'C' : 'S';
    schemaStr += ';';
    if (c.clientOwned) clientOwnedSet.add(c.wireId);
  }
  const hash = fnv1a(schemaStr);

  return {
    components,
    hash,
    clientOwnedWireIds: clientOwnedSet,
    byWireId: (id) => byWireIdMap.get(id),
    bySymbol: (sym) => bySymbolMap.get(sym),
    byName: (name) => byNameMap.get(name),
  };
}
