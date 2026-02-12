import type { EntityId } from 'archetype-ecs';
import type { ClientId } from '../../src/index.js';
import type { ServerTransport } from '../../src/index.js';
import {
  Position, EntityType, Health, Appearance, registry,
  KIND_PLAYER, KIND_TREE, KIND_ROCK, KIND_NPC,
  WORLD_TILES, VIEW_RANGE,
  INPUT_MOVE, INPUT_INTERACT, ACTION_CHOP, ACTION_MINE,
} from '../shared.js';
import { em, encoder, chunks, entityToNetId, getNetId, spawnEntity, destroyEntity, entityAt } from './entities.js';
import { isWalkable } from './world.js';
import { bfs } from './pathfinding.js';

// ── Per-player state ───────────────────────────────────

interface PlayerState {
  path: { x: number; y: number }[];
  interactTarget: { x: number; y: number; action: number } | null;
}

export const clientToPlayer = new Map<ClientId, EntityId>();
export const playerState = new Map<EntityId, PlayerState>();
export const inputQueue = new Map<ClientId, ArrayBuffer[]>();

const respawnQueue: { x: number; y: number; kind: number; variant: number; ticksLeft: number }[] = [];

// ── Player lifecycle ───────────────────────────────────

export function addPlayer(clientId: ClientId): EntityId {
  const eid = spawnEntity(32, 32, KIND_PLAYER, 10, (clientId % 4));
  clientToPlayer.set(clientId, eid);
  playerState.set(eid, { path: [], interactTarget: null });
  inputQueue.set(clientId, []);
  return eid;
}

export function removePlayer(clientId: ClientId) {
  const eid = clientToPlayer.get(clientId);
  if (eid !== undefined) {
    destroyEntity(eid);
    playerState.delete(eid);
    clientToPlayer.delete(clientId);
  }
  inputQueue.delete(clientId);
}

export function queueInput(clientId: ClientId, data: ArrayBuffer) {
  const queue = inputQueue.get(clientId);
  if (queue) queue.push(data);
}

// ── Helpers ────────────────────────────────────────────

function findAdjacentWalkable(tx: number, ty: number): { x: number; y: number } | null {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [dx, dy] of dirs) {
    const nx = tx + dx, ny = ty + dy;
    if (isWalkable(nx, ny)) return { x: nx, y: ny };
  }
  return null;
}

function executeInteraction(tx: number, ty: number, action: number) {
  if (action === ACTION_CHOP) {
    const tree = entityAt(tx, ty, KIND_TREE);
    if (tree !== undefined) {
      const hp = (em.get(tree, Health.current) as number) - 1;
      if (hp <= 0) {
        const v = em.get(tree, Appearance.variant) as number;
        respawnQueue.push({ x: tx, y: ty, kind: KIND_TREE, variant: v, ticksLeft: 30 });
        destroyEntity(tree);
      } else {
        em.set(tree, Health.current, hp);
      }
    }
  } else if (action === ACTION_MINE) {
    const rock = entityAt(tx, ty, KIND_ROCK);
    if (rock !== undefined) {
      const hp = (em.get(rock, Health.current) as number) - 1;
      if (hp <= 0) {
        const v = em.get(rock, Appearance.variant) as number;
        respawnQueue.push({ x: tx, y: ty, kind: KIND_ROCK, variant: v, ticksLeft: 45 });
        destroyEntity(rock);
      } else {
        em.set(rock, Health.current, hp);
      }
    }
  }
}

// ── Systems ────────────────────────────────────────────

export function processInputs() {
  for (const [clientId, buffers] of inputQueue) {
    const eid = clientToPlayer.get(clientId);
    if (eid === undefined) continue;
    const ps = playerState.get(eid);
    if (!ps) continue;

    for (const buf of buffers) {
      const view = new DataView(buf);
      const type = view.getUint8(0);

      if (type === INPUT_MOVE && buf.byteLength >= 5) {
        const tx = view.getInt16(1, true);
        const ty = view.getInt16(3, true);
        const px = em.get(eid, Position.x) as number;
        const py = em.get(eid, Position.y) as number;
        ps.path = bfs(px, py, tx, ty, WORLD_TILES, isWalkable);
        ps.interactTarget = null;
      } else if (type === INPUT_INTERACT && buf.byteLength >= 6) {
        const tx = view.getInt16(1, true);
        const ty = view.getInt16(3, true);
        const action = view.getUint8(5);
        const px = em.get(eid, Position.x) as number;
        const py = em.get(eid, Position.y) as number;

        if (Math.abs(px - tx) <= 1 && Math.abs(py - ty) <= 1 && (px !== tx || py !== ty)) {
          executeInteraction(tx, ty, action);
          ps.path = [];
          ps.interactTarget = null;
        } else {
          const adj = findAdjacentWalkable(tx, ty);
          if (adj) {
            ps.path = bfs(px, py, adj.x, adj.y, WORLD_TILES, isWalkable);
            ps.interactTarget = { x: tx, y: ty, action };
          }
        }
      }
    }
    buffers.length = 0;
  }
}

export function movePlayers() {
  for (const [eid, ps] of playerState) {
    if (ps.path.length === 0) continue;

    const next = ps.path[0];
    const occupied = entityAt(next.x, next.y, KIND_PLAYER);
    if (!isWalkable(next.x, next.y) || (occupied !== undefined && occupied !== eid)) {
      ps.path = [];
      ps.interactTarget = null;
      continue;
    }

    const ox = em.get(eid, Position.x) as number;
    const oy = em.get(eid, Position.y) as number;
    em.set(eid, Position.x, next.x);
    em.set(eid, Position.y, next.y);
    chunks.move(eid, ox, oy, next.x, next.y);
    ps.path.shift();

    if (ps.path.length === 0 && ps.interactTarget) {
      const t = ps.interactTarget;
      const px = em.get(eid, Position.x) as number;
      const py = em.get(eid, Position.y) as number;
      if (Math.abs(px - t.x) <= 1 && Math.abs(py - t.y) <= 1) {
        executeInteraction(t.x, t.y, t.action);
      }
      ps.interactTarget = null;
    }
  }
}

export function npcWanderSystem() {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [eid] of entityToNetId) {
    if (em.get(eid, EntityType.kind) !== KIND_NPC) continue;
    if (Math.random() > 0.3) continue;

    const [dx, dy] = dirs[(Math.random() * 4) | 0];
    const ox = em.get(eid, Position.x) as number;
    const oy = em.get(eid, Position.y) as number;
    const nx = ox + dx, ny = oy + dy;
    if (isWalkable(nx, ny)) {
      em.set(eid, Position.x, nx);
      em.set(eid, Position.y, ny);
      chunks.move(eid, ox, oy, nx, ny);
    }
  }
}

export function respawnSystem() {
  for (let i = respawnQueue.length - 1; i >= 0; i--) {
    const r = respawnQueue[i];
    if (--r.ticksLeft <= 0) {
      if (!entityAt(r.x, r.y)) {
        const hp = r.kind === KIND_TREE ? 3 : 5;
        spawnEntity(r.x, r.y, r.kind, hp, r.variant);
      }
      respawnQueue.splice(i, 1);
    }
  }
}

export function sendStateToClients(transport: ServerTransport) {
  for (const [clientId, eid] of clientToPlayer) {
    const px = em.get(eid, Position.x) as number;
    const py = em.get(eid, Position.y) as number;
    const nearby = entitiesNear(px, py, VIEW_RANGE);
    const buffer = encoder.encodeFullState(em, registry, nearby);
    transport.send(clientId, buffer);
  }
}

function entitiesNear(cx: number, cy: number, range: number): Map<EntityId, number> {
  const result = new Map<EntityId, number>();
  const sets = chunks.queryRange(cx, cy, range, WORLD_TILES);
  for (const set of sets) {
    for (const eid of set) {
      const ex = em.get(eid, Position.x) as number;
      const ey = em.get(eid, Position.y) as number;
      if (Math.abs(ex - cx) <= range && Math.abs(ey - cy) <= range) {
        result.set(eid, getNetId(eid));
      }
    }
  }
  return result;
}
