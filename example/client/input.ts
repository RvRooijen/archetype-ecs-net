import type { EntityId, ComponentDef } from 'archetype-ecs';
import {
  Position, EntityType, Owner, Appearance, Chopping, Mining,
  KIND_TILE, KIND_PLAYER, KIND_TREE, KIND_ROCK, KIND_NPC,
  TILE_WATER, WORLD_TILES, TICK_MS,
} from '../shared.js';
import { bfs } from '../pathfinding.js';
import type { GameState } from './main.js';

// ── Module-level movement state ────────────────────────

let movePath: { x: number; y: number }[] = [];
let interactTarget: { x: number; y: number; action: ComponentDef<any> } | null = null;
let lastStepTime = 0;

// ── Helpers ─────────────────────────────────────────────

function findMe(state: GameState): EntityId | null {
  return state.client.ownedEntities[0] ?? null;
}

function buildTileMap(state: GameState): Uint8Array {
  const { em, client } = state;
  const map = new Uint8Array(WORLD_TILES * WORLD_TILES);
  map.fill(TILE_WATER); // unknown = unwalkable
  for (const [, eid] of client.netToEntity) {
    if (em.get(eid, EntityType.kind) !== KIND_TILE) continue;
    const x = em.get(eid, Position.x) as number;
    const y = em.get(eid, Position.y) as number;
    if (x >= 0 && y >= 0 && x < WORLD_TILES && y < WORLD_TILES) {
      const variant = em.get(eid, Appearance.variant) as number;
      map[y * WORLD_TILES + x] = variant;
    }
  }
  return map;
}

function isWalkableClient(tileMap: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= WORLD_TILES || y >= WORLD_TILES) return false;
  return tileMap[y * WORLD_TILES + x] !== TILE_WATER;
}

function clearActions(state: GameState) {
  const me = findMe(state);
  if (!me) return;
  if (state.em.hasComponent(me, Chopping)) state.em.removeComponent(me, Chopping);
  if (state.em.hasComponent(me, Mining)) state.em.removeComponent(me, Mining);
}

function attachAction(state: GameState, me: EntityId, comp: ComponentDef<any>, tx: number, ty: number) {
  clearActions(state);
  state.em.addComponent(me, comp, { targetX: tx, targetY: ty });
}

function findAdjacentWalkable(tileMap: Uint8Array, tx: number, ty: number): { x: number; y: number } | null {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [dx, dy] of dirs) {
    const nx = tx + dx, ny = ty + dy;
    if (isWalkableClient(tileMap, nx, ny)) return { x: nx, y: ny };
  }
  return null;
}

// ── Click handler: build path ──────────────────────────

function handleClick(state: GameState, tx: number, ty: number, action: ComponentDef<any> | null) {
  const me = findMe(state);
  if (!me) return;

  const px = state.em.get(me, Position.x) as number;
  const py = state.em.get(me, Position.y) as number;
  const tileMap = buildTileMap(state);

  if (!action) {
    // Move
    clearActions(state);
    movePath = bfs(px, py, tx, ty, WORLD_TILES, (x, y) => isWalkableClient(tileMap, x, y));
    interactTarget = null;
  } else {
    // Interact (chop, mine)
    if (Math.abs(px - tx) <= 1 && Math.abs(py - ty) <= 1 && (px !== tx || py !== ty)) {
      // Already adjacent — attach component immediately
      attachAction(state, me, action, tx, ty);
      movePath = [];
      interactTarget = null;
    } else {
      // Walk to adjacent tile first
      clearActions(state);
      const adj = findAdjacentWalkable(tileMap, tx, ty);
      if (adj) {
        movePath = bfs(px, py, adj.x, adj.y, WORLD_TILES, (x, y) => isWalkableClient(tileMap, x, y));
        interactTarget = { x: tx, y: ty, action };
      }
    }
  }
}

// ── Step movement (called from game loop) ──────────────

export function stepMovement(state: GameState, now: number) {
  if (movePath.length === 0) return;
  if (now - lastStepTime < TICK_MS) return;

  const me = findMe(state);
  if (!me) return;

  const next = movePath[0];
  state.em.set(me, Position.x, next.x);
  state.em.set(me, Position.y, next.y);
  movePath.shift();
  lastStepTime = now;

  // Path complete — attach action component if pending
  if (movePath.length === 0 && interactTarget) {
    const t = interactTarget;
    const px = state.em.get(me, Position.x) as number;
    const py = state.em.get(me, Position.y) as number;
    if (Math.abs(px - t.x) <= 1 && Math.abs(py - t.y) <= 1) {
      attachAction(state, me, t.action, t.x, t.y);
    }
    interactTarget = null;
  }
}

// ── Input setup ────────────────────────────────────────

const LONG_PRESS_MS = 400;
const TAP_MOVE_THRESHOLD = 10;

let touchTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartPos: { x: number; y: number } | null = null;

export function setupInput(state: GameState) {
  const { canvas, ctxMenu } = state;

  // Left click: walk to tile
  canvas.addEventListener('click', (e) => {
    hideContextMenu(ctxMenu);
    const t = pointToTile(e.clientX, e.clientY, state);
    if (t) handleClick(state, t.x, t.y, null);
  });

  // Right click: context menu
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = pointToTile(e.clientX, e.clientY, state);
    if (!t) return;
    showContextMenu(state, e.clientX, e.clientY, t);
  });

  // Touch: tap = move, long press = context menu
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    hideContextMenu(ctxMenu);
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    touchStartPos = { x: touch.clientX, y: touch.clientY };
    touchTimer = setTimeout(() => {
      touchTimer = null;
      const t = pointToTile(touchStartPos!.x, touchStartPos!.y, state);
      if (t) showContextMenu(state, touchStartPos!.x, touchStartPos!.y, t);
    }, LONG_PRESS_MS);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!touchStartPos || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPos.x;
    const dy = touch.clientY - touchStartPos.y;
    if (Math.abs(dx) + Math.abs(dy) > TAP_MOVE_THRESHOLD) {
      clearTimeout(touchTimer!);
      touchTimer = null;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
      if (touchStartPos) {
        const t = pointToTile(touchStartPos.x, touchStartPos.y, state);
        if (t) handleClick(state, t.x, t.y, null);
      }
    }
    touchStartPos = null;
  }, { passive: false });

  // Dismiss context menu on click/touch outside
  document.addEventListener('click', (e) => {
    if (e.target !== ctxMenu && !ctxMenu.contains(e.target as Node)) hideContextMenu(ctxMenu);
  });
  document.addEventListener('touchstart', (e) => {
    if (e.target !== ctxMenu && !ctxMenu.contains(e.target as Node)) hideContextMenu(ctxMenu);
  }, { passive: true });

  // Keyboard: directly update Position by ±1
  document.addEventListener('keydown', (e) => {
    const me = findMe(state);
    if (!me) return;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp' || e.key === 'w') dy = -1;
    else if (e.key === 'ArrowDown' || e.key === 's') dy = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'a') dx = -1;
    else if (e.key === 'ArrowRight' || e.key === 'd') dx = 1;
    else return;

    const mx = state.em.get(me, Position.x) as number;
    const my = state.em.get(me, Position.y) as number;
    const nx = mx + dx, ny = my + dy;

    // Check walkability from known tiles
    const tileMap = buildTileMap(state);
    if (!isWalkableClient(tileMap, nx, ny)) return;

    clearActions(state);
    state.em.set(me, Position.x, nx);
    state.em.set(me, Position.y, ny);
    movePath = [];
    interactTarget = null;
  });
}

function pointToTile(cx: number, cy: number, state: GameState): { x: number; y: number } | null {
  const { canvas, em, TILE, VIEW_W, VIEW_H } = state;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx = (cx - rect.left) * scaleX;
  const my = (cy - rect.top) * scaleY;
  const me = findMe(state);
  if (!me) return null;
  const meX = em.get(me, Position.x) as number;
  const meY = em.get(me, Position.y) as number;
  const camX = meX - (VIEW_W / 2 | 0);
  const camY = meY - (VIEW_H / 2 | 0);
  return { x: (mx / TILE | 0) + camX, y: (my / TILE | 0) + camY };
}

function entityAtTile(state: GameState, tx: number, ty: number): { kind: number } | null {
  const { em, client } = state;
  for (const [, eid] of client.netToEntity) {
    const kind = em.get(eid, EntityType.kind) as number;
    if (kind === KIND_TILE) continue;
    if (kind === KIND_PLAYER && em.get(eid, Owner.clientId) === client.clientId) continue;
    if (em.get(eid, Position.x) === tx && em.get(eid, Position.y) === ty) return { kind };
  }
  return null;
}

function showContextMenu(state: GameState, mx: number, my: number, tile: { x: number; y: number }) {
  const { ctxMenu } = state;
  ctxMenu.innerHTML = '';
  const ent = entityAtTile(state, tile.x, tile.y);

  const addOption = (label: string, fn: () => void) => {
    const div = document.createElement('div');
    div.textContent = label;
    div.onclick = () => { fn(); hideContextMenu(ctxMenu); };
    ctxMenu.appendChild(div);
  };

  if (ent && ent.kind === KIND_TREE) {
    addOption('Chop tree', () => handleClick(state, tile.x, tile.y, Chopping));
    addOption('Examine', () => handleClick(state, tile.x, tile.y, null));
  } else if (ent && ent.kind === KIND_ROCK) {
    addOption('Mine rock', () => handleClick(state, tile.x, tile.y, Mining));
    addOption('Examine', () => handleClick(state, tile.x, tile.y, null));
  } else if (ent && ent.kind === KIND_NPC) {
    addOption('Examine', () => handleClick(state, tile.x, tile.y, null));
  } else if (ent && ent.kind === KIND_PLAYER) {
    addOption('Examine', () => handleClick(state, tile.x, tile.y, null));
  } else {
    addOption('Walk here', () => handleClick(state, tile.x, tile.y, null));
  }
  addOption('Cancel', () => {});

  ctxMenu.style.left = mx + 'px';
  ctxMenu.style.top = my + 'px';
  ctxMenu.style.display = 'block';
}

function hideContextMenu(ctxMenu: HTMLElement) {
  ctxMenu.style.display = 'none';
}
