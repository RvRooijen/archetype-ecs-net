import type { ComponentDef } from 'archetype-ecs';

// ── Config ──────────────────────────────────────────────

export interface NetworkConfig {
  port: number;
  maxClients?: number;
  /** Grace period (ms) for reconnecting after disconnect. Default 30000. Set to 0 to disable. */
  reconnectWindow?: number;
}

// ── Component registration ──────────────────────────────

export interface ComponentRegistration {
  component: ComponentDef<any>;
  name: string;
  clientOwned?: boolean;
}

// ── Field schema info ───────────────────────────────────

export type WireType = 'f32' | 'f64' | 'i8' | 'i16' | 'i32' | 'u8' | 'u16' | 'u32' | 'string';

export interface FieldInfo {
  name: string;
  type: WireType;
  byteSize: number; // 0 for string (variable length)
  arraySize: number; // 0 = scalar, >0 = fixed-size array
}

export interface RegisteredComponent {
  wireId: number;        // u8 identifier on the wire
  name: string;
  component: ComponentDef<any>;
  fields: FieldInfo[];
  clientOwned: boolean;  // true = client can write, synced client→server
}

// ── Protocol messages ───────────────────────────────────

export const MSG_FULL = 0x01;
export const MSG_DELTA = 0x02;
export const MSG_CLIENT_DELTA = 0x03;
export const MSG_RECONNECT = 0x04;
export const MSG_REQUEST_FULL = 0x05;
export const MSG_CLIENT_ID = 0xFF;

export interface FullStateMessage {
  type: typeof MSG_FULL;
  entities: Map<number, Map<number, Record<string, unknown>>>;  // netId → wireId → data
}

export interface DeltaMessage {
  type: typeof MSG_DELTA;
  created: Map<number, Map<number, Record<string, unknown>>>;  // netId → wireId → data
  destroyed: number[];  // netIds
  updated: { netId: number; componentWireId: number; fieldMask: number; data: Record<string, unknown> }[];
  attached: { netId: number; componentWireId: number; data: Record<string, unknown> }[];
  detached: { netId: number; componentWireId: number }[];
}

export interface ClientDeltaMessage {
  type: typeof MSG_CLIENT_DELTA;
  updated: { netId: number; componentWireId: number; fieldMask: number; data: Record<string, unknown> }[];
  attached: { netId: number; componentWireId: number; data: Record<string, unknown> }[];
  detached: { netId: number; componentWireId: number }[];
}

export type NetMessage = FullStateMessage | DeltaMessage | ClientDeltaMessage;

// ── Client ID ───────────────────────────────────────────

export type ClientId = number;
