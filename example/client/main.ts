import type { EntityManager } from 'archetype-ecs';
import type { NetClient } from '../../src/index.js';
import { WORLD_TILES } from '../shared.js';
import { em, client, connect } from './net.js';
import { setupInput, stepMovement } from './input.js';
import { render } from './renderer.js';

// ── State type ─────────────────────────────────────────

export interface GameState {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  ctxMenu: HTMLElement;
  em: EntityManager;
  client: NetClient;
  TILE: number;
  VIEW_W: number;
  VIEW_H: number;
  WORLD: number;
}

// ── Shared state object ────────────────────────────────

const state: GameState = {
  canvas: document.getElementById('c') as HTMLCanvasElement,
  hud: document.getElementById('hud')!,
  ctxMenu: document.getElementById('ctx-menu')!,
  em,
  client,
  TILE: 32,
  VIEW_W: 20,
  VIEW_H: 15,
  WORLD: WORLD_TILES,
};

const ctx = state.canvas.getContext('2d')!;

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
  const now = performance.now();
  stepMovement(state, now);
  client.tick();
  render(ctx, state);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
