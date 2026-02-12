import { WORLD } from './constants.js';
import { connect } from './net.js';
import { setupInput } from './input.js';
import { render } from './renderer.js';

// ── Shared state object ────────────────────────────────

const state = {
  canvas: document.getElementById('c'),
  hud: document.getElementById('hud'),
  ctxMenu: document.getElementById('ctx-menu'),
  ws: null,
  tileMap: null,
  myNetId: -1,
  entities: new Map(),
  TILE: 32,
  VIEW_W: 20,
  VIEW_H: 15,
  WORLD,
};

const ctx = state.canvas.getContext('2d');

// ── Responsive sizing ──────────────────────────────────

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  state.TILE = Math.max(24, Math.min(48, Math.floor(Math.min(w, h) / 12)));
  state.VIEW_W = Math.ceil(w / state.TILE);
  state.VIEW_H = Math.ceil(h / state.TILE);
  state.canvas.width = state.VIEW_W * state.TILE;
  state.canvas.height = state.VIEW_H * state.TILE;
}
resize();
window.addEventListener('resize', resize);

// ── Boot ───────────────────────────────────────────────

connect(state);
setupInput(state);

function loop() {
  render(ctx, state);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
