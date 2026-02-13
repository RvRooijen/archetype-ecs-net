import type { EntityId } from 'archetype-ecs';
import type { ClientId, NetServer } from '../../src/index.js';
import {
  Position, EntityType, Health, Appearance, Chopping, Mining,
  KIND_PLAYER, KIND_TREE, KIND_ROCK, KIND_NPC,
  WORLD_TILES, VIEW_RANGE,
} from '../shared.js';
import { em, chunks, spawnEntity, spawnPlayer, destroyEntity, entityAt } from './entities.js';
import { isWalkable } from './world.js';

// ── Per-player state ───────────────────────────────────

const clientToPlayer = new Map<ClientId, EntityId>();

const respawnQueue: { x: number; y: number; kind: number; variant: number; ticksLeft: number }[] = [];

// ── Player lifecycle ───────────────────────────────────

export function addPlayer(clientId: ClientId): EntityId {
  const eid = spawnPlayer(32, 32, clientId, (clientId % 4));
  clientToPlayer.set(clientId, eid);
  return eid;
}

export function removePlayer(clientId: ClientId) {
  const eid = clientToPlayer.get(clientId);
  if (eid !== undefined) {
    destroyEntity(eid);
    clientToPlayer.delete(clientId);
  }
}

// ── Interest filter ────────────────────────────────────

export function getInterest(clientId: ClientId, server: NetServer): Set<number> {
  const eid = clientToPlayer.get(clientId);
  if (eid === undefined) return new Set();

  const px = em.get(eid, Position.x) as number;
  const py = em.get(eid, Position.y) as number;
  const interest = new Set<number>();
  const sets = chunks.queryRange(px, py, VIEW_RANGE, WORLD_TILES);
  for (const set of sets) {
    for (const nearby of set) {
      const ex = em.get(nearby, Position.x) as number;
      const ey = em.get(nearby, Position.y) as number;
      if (Math.abs(ex - px) <= VIEW_RANGE && Math.abs(ey - py) <= VIEW_RANGE) {
        const netId = server.entityNetIds.get(nearby);
        if (netId !== undefined) interest.add(netId);
      }
    }
  }
  return interest;
}

// ── Chopping system (per tick) ─────────────────────────

export function choppingSystem() {
  const toRemove: EntityId[] = [];

  em.forEach([Chopping, Position], (a) => {
    const eids = a.entityIds;
    const txArr = a.field(Chopping.targetX) as Int16Array;
    const tyArr = a.field(Chopping.targetY) as Int16Array;
    const pxArr = a.field(Position.x) as Int16Array;
    const pyArr = a.field(Position.y) as Int16Array;

    for (let i = 0; i < a.count; i++) {
      const eid = eids[i];
      const tx = txArr[i], ty = tyArr[i];
      const px = pxArr[i], py = pyArr[i];

      // Verify adjacency
      if (Math.abs(px - tx) > 1 || Math.abs(py - ty) > 1) {
        toRemove.push(eid);
        continue;
      }

      // Find tree at target
      const tree = entityAt(tx, ty, KIND_TREE);
      if (tree === undefined) {
        toRemove.push(eid);
        continue;
      }

      // Deal 1 damage per tick
      const hp = (em.get(tree, Health.current) as number) - 1;
      if (hp <= 0) {
        const v = em.get(tree, Appearance.variant) as number;
        respawnQueue.push({ x: tx, y: ty, kind: KIND_TREE, variant: v, ticksLeft: 30 });
        destroyEntity(tree);
        toRemove.push(eid);
      } else {
        em.set(tree, Health.current, hp);
      }
    }
  });

  for (const eid of toRemove) em.removeComponent(eid, Chopping);
}

// ── Mining system (per tick) ──────────────────────────

export function miningSystem() {
  const toRemove: EntityId[] = [];

  em.forEach([Mining, Position], (a) => {
    const eids = a.entityIds;
    const txArr = a.field(Mining.targetX) as Int16Array;
    const tyArr = a.field(Mining.targetY) as Int16Array;
    const pxArr = a.field(Position.x) as Int16Array;
    const pyArr = a.field(Position.y) as Int16Array;

    for (let i = 0; i < a.count; i++) {
      const eid = eids[i];
      const tx = txArr[i], ty = tyArr[i];
      const px = pxArr[i], py = pyArr[i];

      // Verify adjacency
      if (Math.abs(px - tx) > 1 || Math.abs(py - ty) > 1) {
        toRemove.push(eid);
        continue;
      }

      // Find rock at target
      const rock = entityAt(tx, ty, KIND_ROCK);
      if (rock === undefined) {
        toRemove.push(eid);
        continue;
      }

      // Deal 1 damage per tick
      const hp = (em.get(rock, Health.current) as number) - 1;
      if (hp <= 0) {
        const v = em.get(rock, Appearance.variant) as number;
        respawnQueue.push({ x: tx, y: ty, kind: KIND_ROCK, variant: v, ticksLeft: 45 });
        destroyEntity(rock);
        toRemove.push(eid);
      } else {
        em.set(rock, Health.current, hp);
      }
    }
  });

  for (const eid of toRemove) em.removeComponent(eid, Mining);
}

// ── Systems ────────────────────────────────────────────

export function npcWanderSystem() {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  em.forEach([EntityType], (a) => {
    const kinds = a.field(EntityType.kind) as Int8Array;
    const eids = a.entityIds;
    for (let i = 0; i < a.count; i++) {
      if (kinds[i] !== KIND_NPC) continue;
      if (Math.random() > 0.3) continue;

      const eid = eids[i];
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
  });
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
