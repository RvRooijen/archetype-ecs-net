import { component } from 'archetype-ecs';
import { createComponentRegistry } from '../../src/index.js';

// ── Components (same order on server & client) ─────────

export const Position = component('Pos', 'f32', ['x', 'y']);
export const Color    = component('Col', 'u8',  ['r', 'g', 'b']);

export const registry = createComponentRegistry([
  { component: Position, name: 'Position' },  // wireId 0
  { component: Color,    name: 'Color' },      // wireId 1
]);

// ── Constants ──────────────────────────────────────────

export const PORT         = 9002;
export const TICK_RATE    = 20;
export const TICK_MS      = Math.floor(1000 / TICK_RATE);
export const ENTITY_COUNT = 20;
export const WORLD_SIZE   = 400; // pixels
