import {
  Position, EntityType, Health, Appearance,
  KIND_TILE, KIND_PLAYER, KIND_TREE, KIND_ROCK, KIND_NPC,
} from '../shared.js';
import type { GameState } from './main.js';

const TILE_COLORS = ['#4a7c3f', '#2a5a9e', '#8b7355'];
const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
const TREE_GREENS = ['#2d6b22', '#1e8c1e', '#3a8a2e'];
const ROCK_GRAYS = ['#888', '#999', '#777'];
const NPC_COLORS = ['#e6c74c', '#d4a040', '#c4943a', '#b8883a'];

export function render(ctx: CanvasRenderingContext2D, state: GameState) {
  const { canvas, em, client, TILE, VIEW_W, VIEW_H } = state;
  const cw = canvas.width, ch = canvas.height;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, cw, ch);

  // Find own player via ownedEntities helper
  const meEid = client.ownedEntities[0] ?? null;
  let meNetId = -1;
  if (meEid !== null) {
    for (const [netId, eid] of client.netToEntity) {
      if (eid === meEid) { meNetId = netId; break; }
    }
  }

  if (meEid === null) return;

  const meX = em.get(meEid, Position.x) as number;
  const meY = em.get(meEid, Position.y) as number;
  const camX = meX - (VIEW_W / 2 | 0);
  const camY = meY - (VIEW_H / 2 | 0);

  // Pass 1: tiles
  for (const [, eid] of client.netToEntity) {
    if (em.get(eid, EntityType.kind) !== KIND_TILE) continue;
    const ex = em.get(eid, Position.x) as number;
    const ey = em.get(eid, Position.y) as number;
    const sx = (ex - camX) * TILE;
    const sy = (ey - camY) * TILE;
    if (sx < -TILE || sy < -TILE || sx > cw || sy > ch) continue;
    const variant = em.get(eid, Appearance.variant) as number;
    ctx.fillStyle = TILE_COLORS[variant] || '#000';
    ctx.fillRect(sx, sy, TILE, TILE);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.strokeRect(sx, sy, TILE, TILE);
  }

  // Pass 2: game entities
  for (const [netId, eid] of client.netToEntity) {
    const kind = em.get(eid, EntityType.kind) as number;
    if (kind === KIND_TILE) continue;

    const ex = em.get(eid, Position.x) as number;
    const ey = em.get(eid, Position.y) as number;
    const sx = (ex - camX) * TILE;
    const sy = (ey - camY) * TILE;
    if (sx < -TILE || sy < -TILE || sx > cw || sy > ch) continue;

    const variant = em.get(eid, Appearance.variant) as number;
    const T = TILE;
    const half = T / 2;
    const pad = T * 0.125;

    switch (kind) {
      case KIND_PLAYER:
        ctx.fillStyle = PLAYER_COLORS[variant] || '#fff';
        ctx.fillRect(sx + pad, sy + pad, T - pad * 2, T - pad * 2);
        if (netId === meNetId) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(sx + pad - 1, sy + pad - 1, T - pad * 2 + 2, T - pad * 2 + 2);
          ctx.lineWidth = 1;
        }
        break;

      case KIND_TREE:
        ctx.fillStyle = '#6b4423';
        ctx.fillRect(sx + T * 0.375, sy + T * 0.56, T * 0.25, T * 0.44);
        ctx.fillStyle = TREE_GREENS[variant] || '#2d6b22';
        ctx.beginPath();
        ctx.arc(sx + half, sy + T * 0.44, T * 0.34, 0, Math.PI * 2);
        ctx.fill();
        break;

      case KIND_ROCK:
        ctx.fillStyle = ROCK_GRAYS[variant] || '#888';
        ctx.beginPath();
        ctx.moveTo(sx + T * 0.19, sy + T * 0.81);
        ctx.lineTo(sx + half, sy + T * 0.19);
        ctx.lineTo(sx + T * 0.875, sy + T * 0.69);
        ctx.lineTo(sx + T * 0.625, sy + T * 0.875);
        ctx.closePath();
        ctx.fill();
        break;

      case KIND_NPC:
        ctx.fillStyle = NPC_COLORS[variant] || '#e6c74c';
        ctx.fillRect(sx + pad * 1.5, sy + pad * 1.5, T - pad * 3, T - pad * 3);
        ctx.fillStyle = '#000';
        ctx.font = `${Math.round(T * 0.25)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('NPC', sx + half, sy + T * 0.625);
        break;
    }

    // Health bar (not for full HP)
    if (kind !== KIND_TILE) {
      const hp = em.get(eid, Health.current) as number | undefined;
      const maxHp = em.get(eid, Health.max) as number | undefined;
      if (hp !== undefined && maxHp !== undefined && hp < maxHp && hp > 0) {
        const bw = T - pad * 2;
        ctx.fillStyle = '#333';
        ctx.fillRect(sx + pad, sy - pad, bw, pad);
        ctx.fillStyle = '#2ecc71';
        ctx.fillRect(sx + pad, sy - pad, (hp / maxHp) * bw, pad);
      }
    }
  }

  // HUD
  const meHp = em.get(meEid, Health.current) as number;
  const meMaxHp = em.get(meEid, Health.max) as number;
  state.hud.textContent = `Pos: ${meX}, ${meY}  |  HP: ${meHp}/${meMaxHp}  |  Entities: ${client.netToEntity.size}`;
}
