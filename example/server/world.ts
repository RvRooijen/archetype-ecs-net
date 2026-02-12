import {
  WORLD_TILES, TILE_GRASS, TILE_WATER, TILE_PATH,
  KIND_TREE, KIND_ROCK, KIND_NPC,
} from '../shared.js';
import { spawnEntity, entityAt } from './entities.js';

export const tileMap = new Uint8Array(WORLD_TILES * WORLD_TILES);

export function tileAt(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= WORLD_TILES || y >= WORLD_TILES) return TILE_WATER;
  return tileMap[y * WORLD_TILES + x];
}

export function isWalkable(x: number, y: number): boolean {
  return tileAt(x, y) !== TILE_WATER;
}

export function generateWorld() {
  tileMap.fill(TILE_GRASS);

  const rng = (n: number) => (Math.random() * n) | 0;

  // Water clusters
  for (let lake = 0; lake < 6; lake++) {
    const cx = 5 + rng(WORLD_TILES - 10);
    const cy = 5 + rng(WORLD_TILES - 10);
    const r = 2 + rng(3);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < WORLD_TILES && y < WORLD_TILES) {
            tileMap[y * WORLD_TILES + x] = TILE_WATER;
          }
        }
      }
    }
  }

  // Paths — horizontal and vertical through center
  for (let i = 0; i < WORLD_TILES; i++) {
    tileMap[32 * WORLD_TILES + i] = TILE_PATH;
    tileMap[i * WORLD_TILES + 32] = TILE_PATH;
  }

  // Clear spawn area
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      tileMap[(32 + dy) * WORLD_TILES + (32 + dx)] = TILE_PATH;
    }
  }

  // Trees
  for (let i = 0; i < 80; i++) {
    const x = rng(WORLD_TILES), y = rng(WORLD_TILES);
    if (tileAt(x, y) === TILE_GRASS && !entityAt(x, y)) {
      spawnEntity(x, y, KIND_TREE, 3, rng(3));
    }
  }

  // Rocks
  for (let i = 0; i < 40; i++) {
    const x = rng(WORLD_TILES), y = rng(WORLD_TILES);
    if (tileAt(x, y) === TILE_GRASS && !entityAt(x, y)) {
      spawnEntity(x, y, KIND_ROCK, 5, rng(3));
    }
  }

  // NPCs
  for (let i = 0; i < 10; i++) {
    const x = 28 + rng(9), y = 28 + rng(9);
    if (isWalkable(x, y)) {
      spawnEntity(x, y, KIND_NPC, 10, rng(4));
    }
  }
}
