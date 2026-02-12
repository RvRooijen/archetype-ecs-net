import { createEntityManager } from 'archetype-ecs';
import type { EntityId } from 'archetype-ecs';
// Use 'archetype-ecs-net' when outside this repo
import { createWsTransport, ProtocolEncoder } from '../src/index.js';
import type { ClientId } from '../src/index.js';
import {
  Position, EntityType, Health, Appearance, registry,
  KIND_PLAYER, KIND_TREE, KIND_ROCK, KIND_NPC,
  WORLD_TILES, CHUNK_SIZE, VIEW_RANGE, TICK_MS,
  TILE_GRASS, TILE_WATER, TILE_PATH,
  INPUT_MOVE, INPUT_INTERACT, ACTION_CHOP, ACTION_MINE,
  MSG_TILE_MAP, MSG_PLAYER_ID,
} from './shared.js';

// ── State ───────────────────────────────────────────────

const em = createEntityManager();
const encoder = new ProtocolEncoder();
const transport = createWsTransport();

const tileMap = new Uint8Array(WORLD_TILES * WORLD_TILES);

let nextNetId = 1;
const entityToNetId = new Map<EntityId, number>();

const clientToPlayer = new Map<ClientId, EntityId>();
const inputQueue = new Map<ClientId, ArrayBuffer[]>();

interface PlayerState {
  path: { x: number; y: number }[];
  interactTarget: { x: number; y: number; action: number } | null;
}
const playerState = new Map<EntityId, PlayerState>();

const respawnQueue: { x: number; y: number; kind: number; variant: number; ticksLeft: number }[] = [];

// ── Chunk Manager ───────────────────────────────────────

const chunkEntities = new Map<number, Set<EntityId>>();

function chunkKey(tx: number, ty: number): number {
  return (tx >> 3) | ((ty >> 3) << 8);
}

function chunkAdd(eid: EntityId, tx: number, ty: number) {
  const k = chunkKey(tx, ty);
  let set = chunkEntities.get(k);
  if (!set) { set = new Set(); chunkEntities.set(k, set); }
  set.add(eid);
}

function chunkRemove(eid: EntityId, tx: number, ty: number) {
  chunkEntities.get(chunkKey(tx, ty))?.delete(eid);
}

function chunkMove(eid: EntityId, ox: number, oy: number, nx: number, ny: number) {
  const ok = chunkKey(ox, oy), nk = chunkKey(nx, ny);
  if (ok !== nk) {
    chunkEntities.get(ok)?.delete(eid);
    let set = chunkEntities.get(nk);
    if (!set) { set = new Set(); chunkEntities.set(nk, set); }
    set.add(eid);
  }
}

function entitiesNear(cx: number, cy: number, range: number): Map<EntityId, number> {
  const result = new Map<EntityId, number>();
  const cxMin = Math.max(0, (cx - range) >> 3);
  const cxMax = Math.min((WORLD_TILES - 1) >> 3, (cx + range) >> 3);
  const cyMin = Math.max(0, (cy - range) >> 3);
  const cyMax = Math.min((WORLD_TILES - 1) >> 3, (cy + range) >> 3);

  for (let chy = cyMin; chy <= cyMax; chy++) {
    for (let chx = cxMin; chx <= cxMax; chx++) {
      const set = chunkEntities.get(chx | (chy << 8));
      if (!set) continue;
      for (const eid of set) {
        const ex = em.get(eid, Position.x) as number;
        const ey = em.get(eid, Position.y) as number;
        if (Math.abs(ex - cx) <= range && Math.abs(ey - cy) <= range) {
          result.set(eid, getNetId(eid));
        }
      }
    }
  }
  return result;
}

// ── Helpers ─────────────────────────────────────────────

function getNetId(eid: EntityId): number {
  let id = entityToNetId.get(eid);
  if (id === undefined) { id = nextNetId++; entityToNetId.set(eid, id); }
  return id;
}

function tileAt(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= WORLD_TILES || y >= WORLD_TILES) return TILE_WATER;
  return tileMap[y * WORLD_TILES + x];
}

function isWalkable(x: number, y: number): boolean {
  return tileAt(x, y) !== TILE_WATER;
}

function entityAt(tx: number, ty: number, kind?: number): EntityId | undefined {
  const set = chunkEntities.get(chunkKey(tx, ty));
  if (!set) return undefined;
  for (const eid of set) {
    if (em.get(eid, Position.x) === tx && em.get(eid, Position.y) === ty) {
      if (kind === undefined || em.get(eid, EntityType.kind) === kind) return eid;
    }
  }
  return undefined;
}

function spawnEntity(x: number, y: number, kind: number, hp: number, variant: number): EntityId {
  const eid = em.createEntityWith(
    Position, { x, y },
    EntityType, { kind },
    Health, { current: hp, max: hp },
    Appearance, { variant },
  );
  chunkAdd(eid, x, y);
  getNetId(eid);
  return eid;
}

function destroyEntity(eid: EntityId) {
  const x = em.get(eid, Position.x) as number;
  const y = em.get(eid, Position.y) as number;
  chunkRemove(eid, x, y);
  entityToNetId.delete(eid);
  em.destroyEntity(eid);
}

// ── BFS Pathfinding ─────────────────────────────────────

function bfs(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] {
  if (sx === tx && sy === ty) return [];
  if (!isWalkable(tx, ty)) return [];

  const W = WORLD_TILES;
  const visited = new Uint8Array(W * W);
  const parent = new Int16Array(W * W).fill(-1);
  const queue: number[] = [sy * W + sx];
  visited[sy * W + sx] = 1;

  const dirs = [0, -1, 1, 0, 0, 1, -1, 0]; // N E S W

  while (queue.length > 0) {
    const idx = queue.shift()!;
    const cx = idx % W, cy = (idx / W) | 0;

    for (let d = 0; d < 8; d += 2) {
      const nx = cx + dirs[d], ny = cy + dirs[d + 1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const ni = ny * W + nx;
      if (visited[ni] || !isWalkable(nx, ny)) continue;
      visited[ni] = 1;
      parent[ni] = idx;

      if (nx === tx && ny === ty) {
        // Reconstruct path
        const path: { x: number; y: number }[] = [];
        let cur = ni;
        while (cur !== sy * W + sx) {
          path.push({ x: cur % W, y: (cur / W) | 0 });
          cur = parent[cur];
        }
        path.reverse();
        return path;
      }
      queue.push(ni);
    }
  }
  return []; // no path
}

// ── World Generation ────────────────────────────────────

function generateWorld() {
  // Fill grass
  tileMap.fill(TILE_GRASS);

  // Water clusters
  const rng = (n: number) => (Math.random() * n) | 0;
  for (let lake = 0; lake < 6; lake++) {
    const cx = 5 + rng(WORLD_TILES - 10);
    const cy = 5 + rng(WORLD_TILES - 10);
    const r = 2 + rng(3);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < WORLD_TILES && y < WORLD_TILES) {
            tileMap[y * WORLD_TILES + x] = TILE_WATER;
          }
        }
      }
    }
  }

  // Paths — horizontal and vertical through center
  for (let i = 0; i < WORLD_TILES; i++) {
    tileMap[32 * WORLD_TILES + i] = TILE_PATH;
    tileMap[i * WORLD_TILES + 32] = TILE_PATH;
  }

  // Clear spawn area
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      tileMap[(32 + dy) * WORLD_TILES + (32 + dx)] = TILE_PATH;
    }
  }

  // Trees
  for (let i = 0; i < 80; i++) {
    const x = rng(WORLD_TILES), y = rng(WORLD_TILES);
    if (tileAt(x, y) === TILE_GRASS && !entityAt(x, y)) {
      spawnEntity(x, y, KIND_TREE, 3, rng(3));
    }
  }

  // Rocks
  for (let i = 0; i < 40; i++) {
    const x = rng(WORLD_TILES), y = rng(WORLD_TILES);
    if (tileAt(x, y) === TILE_GRASS && !entityAt(x, y)) {
      spawnEntity(x, y, KIND_ROCK, 5, rng(3));
    }
  }

  // NPCs
  for (let i = 0; i < 10; i++) {
    const x = 28 + rng(9), y = 28 + rng(9);
    if (isWalkable(x, y)) {
      spawnEntity(x, y, KIND_NPC, 10, rng(4));
    }
  }
}

// ── Systems ─────────────────────────────────────────────

function processInputs() {
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
        ps.path = bfs(px, py, tx, ty);
        ps.interactTarget = null;
      } else if (type === INPUT_INTERACT && buf.byteLength >= 6) {
        const tx = view.getInt16(1, true);
        const ty = view.getInt16(3, true);
        const action = view.getUint8(5);
        const px = em.get(eid, Position.x) as number;
        const py = em.get(eid, Position.y) as number;

        // If adjacent, interact immediately; otherwise walk there first
        if (Math.abs(px - tx) <= 1 && Math.abs(py - ty) <= 1 && (px !== tx || py !== ty)) {
          executeInteraction(tx, ty, action);
          ps.path = [];
          ps.interactTarget = null;
        } else {
          // Find an adjacent walkable tile to walk to
          const adj = findAdjacentWalkable(tx, ty);
          if (adj) {
            ps.path = bfs(px, py, adj.x, adj.y);
            ps.interactTarget = { x: tx, y: ty, action };
          }
        }
      }
    }
    buffers.length = 0;
  }
}

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

function movePlayers() {
  for (const [eid, ps] of playerState) {
    if (ps.path.length === 0) continue;

    const next = ps.path[0];
    // Verify still walkable and no player collision
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
    chunkMove(eid, ox, oy, next.x, next.y);
    ps.path.shift();

    // If path done and interact target set, try to interact
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

function npcWanderSystem() {
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
      chunkMove(eid, ox, oy, nx, ny);
    }
  }
}

function respawnSystem() {
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

function sendStateToClients() {
  for (const [clientId, eid] of clientToPlayer) {
    const px = em.get(eid, Position.x) as number;
    const py = em.get(eid, Position.y) as number;
    const nearby = entitiesNear(px, py, VIEW_RANGE);
    const buffer = encoder.encodeFullState(em, registry, nearby);
    transport.send(clientId, buffer);
  }
}

// ── Connection Handling ─────────────────────────────────

function sendTileMap(clientId: ClientId) {
  const buf = new ArrayBuffer(2 + tileMap.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_TILE_MAP);
  view.setUint8(1, WORLD_TILES);
  new Uint8Array(buf, 2).set(tileMap);
  transport.send(clientId, buf);
}

function sendPlayerId(clientId: ClientId, netId: number) {
  const buf = new ArrayBuffer(3);
  const view = new DataView(buf);
  view.setUint8(0, MSG_PLAYER_ID);
  view.setUint16(1, netId, true);
  transport.send(clientId, buf);
}

// ── Start ───────────────────────────────────────────────

generateWorld();
console.log(`World generated: ${WORLD_TILES}x${WORLD_TILES} tiles, ${entityToNetId.size} entities`);

await transport.start(9001, {
  onOpen(clientId) {
    // Spawn player at center
    const eid = spawnEntity(32, 32, KIND_PLAYER, 10, (clientId % 4));
    clientToPlayer.set(clientId, eid);
    playerState.set(eid, { path: [], interactTarget: null });
    inputQueue.set(clientId, []);

    sendTileMap(clientId);
    sendPlayerId(clientId, getNetId(eid));
    console.log(`Client ${clientId} connected (player netId=${getNetId(eid)})`);
  },

  onClose(clientId) {
    const eid = clientToPlayer.get(clientId);
    if (eid !== undefined) {
      destroyEntity(eid);
      playerState.delete(eid);
      clientToPlayer.delete(clientId);
    }
    inputQueue.delete(clientId);
    console.log(`Client ${clientId} disconnected`);
  },

  onMessage(clientId, data) {
    const queue = inputQueue.get(clientId);
    if (queue) queue.push(data);
  },
});

console.log(`Server listening on ws://localhost:9001 (${TICK_MS}ms tick)`);

setInterval(() => {
  processInputs();
  movePlayers();
  npcWanderSystem();
  respawnSystem();
  sendStateToClients();
}, TICK_MS);
