import { component } from 'archetype-ecs';
// Use 'archetype-ecs-net' when outside this repo
import { createComponentRegistry } from '../src/index.js';

// ── Components (same order on server & client) ─────────

export const Position   = component('Pos',   'i16', ['x', 'y']);
export const EntityType = component('EType', 'u8',  ['kind']);
export const Health     = component('Hp',    'i16', ['current', 'max']);
export const Appearance = component('App',   'u8',  ['variant']);

export const registry = createComponentRegistry([
  { component: Position,   name: 'Position' },    // wireId 0
  { component: EntityType, name: 'EntityType' },   // wireId 1
  { component: Health,     name: 'Health' },        // wireId 2
  { component: Appearance, name: 'Appearance' },    // wireId 3
]);

// ── Entity kinds ────────────────────────────────────────

export const KIND_PLAYER = 1;
export const KIND_TREE   = 2;
export const KIND_ROCK   = 3;
export const KIND_NPC    = 4;

// ── World constants ─────────────────────────────────────

export const TILE_SIZE    = 32;   // pixels per tile (client)
export const CHUNK_SIZE   = 8;    // tiles per chunk edge
export const WORLD_CHUNKS = 8;    // chunks per world edge
export const WORLD_TILES  = CHUNK_SIZE * WORLD_CHUNKS; // 64
export const VIEW_RANGE   = 12;   // tile radius for interest management
export const TICK_RATE    = 3;    // server ticks per second
export const TICK_MS      = Math.floor(1000 / TICK_RATE);

// ── Tile types ──────────────────────────────────────────

export const TILE_GRASS = 0;
export const TILE_WATER = 1;
export const TILE_PATH  = 2;

// ── Client→Server input types ───────────────────────────

export const INPUT_MOVE     = 1; // + i16 targetX, i16 targetY
export const INPUT_INTERACT = 2; // + i16 tileX, i16 tileY, u8 action

export const ACTION_CHOP    = 1;
export const ACTION_MINE    = 2;
export const ACTION_EXAMINE = 3;

// ── Custom server→client message markers ────────────────

export const MSG_TILE_MAP  = 0xFE;
export const MSG_PLAYER_ID = 0xFD;
