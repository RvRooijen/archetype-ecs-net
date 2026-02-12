import { WORLD_SIZE } from './constants.js';

export function render(ctx, state) {
  const { canvas } = state;
  const scale = canvas.width / WORLD_SIZE;

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Entities as colored circles
  for (const [, ent] of state.entities) {
    const sx = ent.x * scale;
    const sy = ent.y * scale;
    const r = Math.max(4, 6 * scale);

    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${ent.r ?? 255},${ent.g ?? 255},${ent.b ?? 255})`;
    ctx.fill();
  }

  // Status
  ctx.fillStyle = '#eee';
  ctx.font = '12px monospace';
  ctx.fillText(`${state.status}  |  Entities: ${state.entities.size}`, 8, 16);
}
