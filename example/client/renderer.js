import { KIND_PLAYER, KIND_TREE, KIND_ROCK, KIND_NPC } from './constants.js';

const TILE_COLORS = ['#4a7c3f', '#2a5a9e', '#8b7355'];
const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
const TREE_GREENS = ['#2d6b22', '#1e8c1e', '#3a8a2e'];
const ROCK_GRAYS = ['#888', '#999', '#777'];
const NPC_COLORS = ['#e6c74c', '#d4a040', '#c4943a', '#b8883a'];

export function render(ctx, state) {
  const { canvas, tileMap, entities, myNetId, TILE, VIEW_W, VIEW_H, WORLD } = state;
  const cw = canvas.width, ch = canvas.height;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, cw, ch);

  if (!tileMap) return;

  const me = entities.get(myNetId);
  const camX = me ? me.x - (VIEW_W / 2 | 0) : 0;
  const camY = me ? me.y - (VIEW_H / 2 | 0) : 0;

  drawTiles(ctx, state, camX, camY);
  drawEntities(ctx, state, camX, camY, cw, ch);
  drawHUD(state, me);
}

function drawTiles(ctx, { tileMap, TILE, VIEW_W, VIEW_H, WORLD }, camX, camY) {
  for (let dy = 0; dy < VIEW_H + 1; dy++) {
    for (let dx = 0; dx < VIEW_W + 1; dx++) {
      const tx = camX + dx, ty = camY + dy;
      if (tx < 0 || ty < 0 || tx >= WORLD || ty >= WORLD) continue;
      ctx.fillStyle = TILE_COLORS[tileMap[ty * WORLD + tx]] || '#000';
      ctx.fillRect(dx * TILE, dy * TILE, TILE, TILE);
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.strokeRect(dx * TILE, dy * TILE, TILE, TILE);
    }
  }
}

function drawEntities(ctx, { entities, myNetId, TILE }, camX, camY, cw, ch) {
  for (const [netId, e] of entities) {
    const sx = (e.x - camX) * TILE;
    const sy = (e.y - camY) * TILE;
    if (sx < -TILE || sy < -TILE || sx > cw || sy > ch) continue;

    const T = TILE;
    const half = T / 2;
    const pad = T * 0.125;

    switch (e.kind) {
      case KIND_PLAYER:
        ctx.fillStyle = PLAYER_COLORS[e.variant] || '#fff';
        ctx.fillRect(sx + pad, sy + pad, T - pad * 2, T - pad * 2);
        if (netId === myNetId) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(sx + pad - 1, sy + pad - 1, T - pad * 2 + 2, T - pad * 2 + 2);
          ctx.lineWidth = 1;
        }
        break;

      case KIND_TREE:
        ctx.fillStyle = '#6b4423';
        ctx.fillRect(sx + T * 0.375, sy + T * 0.56, T * 0.25, T * 0.44);
        ctx.fillStyle = TREE_GREENS[e.variant] || '#2d6b22';
        ctx.beginPath();
        ctx.arc(sx + half, sy + T * 0.44, T * 0.34, 0, Math.PI * 2);
        ctx.fill();
        break;

      case KIND_ROCK:
        ctx.fillStyle = ROCK_GRAYS[e.variant] || '#888';
        ctx.beginPath();
        ctx.moveTo(sx + T * 0.19, sy + T * 0.81);
        ctx.lineTo(sx + half, sy + T * 0.19);
        ctx.lineTo(sx + T * 0.875, sy + T * 0.69);
        ctx.lineTo(sx + T * 0.625, sy + T * 0.875);
        ctx.closePath();
        ctx.fill();
        break;

      case KIND_NPC:
        ctx.fillStyle = NPC_COLORS[e.variant] || '#e6c74c';
        ctx.fillRect(sx + pad * 1.5, sy + pad * 1.5, T - pad * 3, T - pad * 3);
        ctx.fillStyle = '#000';
        ctx.font = `${Math.round(T * 0.25)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('NPC', sx + half, sy + T * 0.625);
        break;
    }

    // Health bar (not for full HP)
    if (e.hp < e.maxHp && e.hp > 0) {
      const bw = T - pad * 2;
      ctx.fillStyle = '#333';
      ctx.fillRect(sx + pad, sy - pad, bw, pad);
      ctx.fillStyle = '#2ecc71';
      ctx.fillRect(sx + pad, sy - pad, (e.hp / e.maxHp) * bw, pad);
    }
  }
}

function drawHUD({ hud, entities, myNetId }, me) {
  if (me) {
    hud.textContent = `Pos: ${me.x}, ${me.y}  |  HP: ${me.hp}/${me.maxHp}  |  Entities: ${entities.size}`;
  }
}
