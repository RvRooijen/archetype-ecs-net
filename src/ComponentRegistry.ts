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
  /** Look up by wire ID */
  byWireId(id: number): RegisteredComponent | undefined;
  /** Look up by component symbol */
  bySymbol(sym: symbol): RegisteredComponent | undefined;
  /** Look up by wire name */
  byName(name: string): RegisteredComponent | undefined;
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
      for (const [fieldName, Ctor] of Object.entries(schema)) {
        const wireType = CTOR_TO_TYPE.get(Ctor);
        if (!wireType) throw new Error(`Unknown constructor for field "${fieldName}" in "${reg.name}"`);
        fields.push({
          name: fieldName,
          type: wireType,
          byteSize: TYPE_BYTE_SIZE[wireType],
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
    };

    components.push(entry);
    byWireIdMap.set(i, entry);
    bySymbolMap.set(sym, entry);
    byNameMap.set(reg.name, entry);
  }

  return {
    components,
    byWireId: (id) => byWireIdMap.get(id),
    bySymbol: (sym) => bySymbolMap.get(sym),
    byName: (name) => byNameMap.get(name),
  };
}
