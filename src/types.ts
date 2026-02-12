import type { ComponentDef } from 'archetype-ecs';

// ── Config ──────────────────────────────────────────────

export interface NetworkConfig {
  port: number;
  maxClients?: number;
}

// ── Component registration ──────────────────────────────

export interface ComponentRegistration {
  component: ComponentDef<any>;
  name: string;
}

// ── Field schema info ───────────────────────────────────

export type WireType = 'f32' | 'f64' | 'i8' | 'i16' | 'i32' | 'u8' | 'u16' | 'u32' | 'string';

export interface FieldInfo {
  name: string;
  type: WireType;
  byteSize: number; // 0 for string (variable length)
}

export interface RegisteredComponent {
  wireId: number;        // u8 identifier on the wire
  name: string;
  component: ComponentDef<any>;
  fields: FieldInfo[];
}

// ── Protocol messages ───────────────────────────────────

export const MSG_FULL = 0x01;
export const MSG_DELTA = 0x02;

export interface FullStateMessage {
  type: typeof MSG_FULL;
  entities: Map<number, Map<number, Record<string, unknown>>>;  // netId → wireId → data
}

export interface DeltaMessage {
  type: typeof MSG_DELTA;
  created: Map<number, Map<number, Record<string, unknown>>>;  // netId → wireId → data
  destroyed: number[];  // netIds
  updated: { netId: number; componentWireId: number; fieldMask: number; data: Record<string, unknown> }[];
}

export type NetMessage = FullStateMessage | DeltaMessage;

// ── Client ID ───────────────────────────────────────────

export type ClientId = number;
