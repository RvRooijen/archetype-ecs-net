import {
  KIND_PLAYER, KIND_TREE, KIND_ROCK, KIND_NPC,
  ACTION_CHOP, ACTION_MINE, ACTION_EXAMINE,
} from './constants.js';
import { sendMove, sendInteract } from './net.js';

const LONG_PRESS_MS = 400;
const TAP_MOVE_THRESHOLD = 10;

let touchTimer = null;
let touchStartPos = null;

export function setupInput(state) {
  const { canvas, ctxMenu } = state;

  // Left click: walk to tile
  canvas.addEventListener('click', (e) => {
    hideContextMenu(ctxMenu);
    const t = pointToTile(e.clientX, e.clientY, state);
    if (t) sendMove(state, t.x, t.y);
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
      const t = pointToTile(touchStartPos.x, touchStartPos.y, state);
      if (t) showContextMenu(state, touchStartPos.x, touchStartPos.y, t);
    }, LONG_PRESS_MS);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!touchStartPos || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPos.x;
    const dy = touch.clientY - touchStartPos.y;
    if (Math.abs(dx) + Math.abs(dy) > TAP_MOVE_THRESHOLD) {
      clearTimeout(touchTimer);
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
        if (t) sendMove(state, t.x, t.y);
      }
    }
    touchStartPos = null;
  }, { passive: false });

  // Dismiss context menu on click/touch outside
  document.addEventListener('click', (e) => {
    if (e.target !== ctxMenu && !ctxMenu.contains(e.target)) hideContextMenu(ctxMenu);
  });
  document.addEventListener('touchstart', (e) => {
    if (e.target !== ctxMenu && !ctxMenu.contains(e.target)) hideContextMenu(ctxMenu);
  }, { passive: true });

  // Keyboard fallback
  document.addEventListener('keydown', (e) => {
    const me = state.entities.get(state.myNetId);
    if (!me) return;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp' || e.key === 'w') dy = -1;
    else if (e.key === 'ArrowDown' || e.key === 's') dy = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'a') dx = -1;
    else if (e.key === 'ArrowRight' || e.key === 'd') dx = 1;
    else return;
    sendMove(state, me.x + dx, me.y + dy);
  });
}

function pointToTile(cx, cy, state) {
  const { canvas, entities, myNetId, TILE, VIEW_W, VIEW_H } = state;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx = (cx - rect.left) * scaleX;
  const my = (cy - rect.top) * scaleY;
  const me = entities.get(myNetId);
  if (!me) return null;
  const camX = me.x - (VIEW_W / 2 | 0);
  const camY = me.y - (VIEW_H / 2 | 0);
  return { x: (mx / TILE | 0) + camX, y: (my / TILE | 0) + camY };
}

function entityAtTile(state, tx, ty) {
  for (const [netId, e] of state.entities) {
    if (e.x === tx && e.y === ty && netId !== state.myNetId) return e;
  }
  return null;
}

function showContextMenu(state, mx, my, tile) {
  const { ctxMenu } = state;
  ctxMenu.innerHTML = '';
  const ent = entityAtTile(state, tile.x, tile.y);

  const addOption = (label, fn) => {
    const div = document.createElement('div');
    div.textContent = label;
    div.onclick = () => { fn(); hideContextMenu(ctxMenu); };
    ctxMenu.appendChild(div);
  };

  if (ent && ent.kind === KIND_TREE) {
    addOption('Chop tree', () => sendInteract(state, tile.x, tile.y, ACTION_CHOP));
    addOption('Examine', () => sendInteract(state, tile.x, tile.y, ACTION_EXAMINE));
  } else if (ent && ent.kind === KIND_ROCK) {
    addOption('Mine rock', () => sendInteract(state, tile.x, tile.y, ACTION_MINE));
    addOption('Examine', () => sendInteract(state, tile.x, tile.y, ACTION_EXAMINE));
  } else if (ent && ent.kind === KIND_NPC) {
    addOption('Examine', () => sendInteract(state, tile.x, tile.y, ACTION_EXAMINE));
  } else if (ent && ent.kind === KIND_PLAYER) {
    addOption('Examine', () => sendInteract(state, tile.x, tile.y, ACTION_EXAMINE));
  } else {
    addOption('Walk here', () => sendMove(state, tile.x, tile.y));
  }
  addOption('Cancel', () => {});

  ctxMenu.style.left = mx + 'px';
  ctxMenu.style.top = my + 'px';
  ctxMenu.style.display = 'block';
}

function hideContextMenu(ctxMenu) {
  ctxMenu.style.display = 'none';
}
