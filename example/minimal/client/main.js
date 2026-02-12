import { WORLD_SIZE } from './constants.js';
import { connect } from './net.js';
import { render } from './renderer.js';

const state = {
  canvas: document.getElementById('c'),
  status: 'Connecting...',
  entities: new Map(),
};

// Size canvas to fit viewport, maintain square aspect
function resize() {
  const size = Math.min(window.innerWidth, window.innerHeight);
  state.canvas.width = size;
  state.canvas.height = size;
}
resize();
window.addEventListener('resize', resize);

const ctx = state.canvas.getContext('2d');

connect(state);

function loop() {
  render(ctx, state);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
