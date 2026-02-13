// Use 'archetype-ecs-net' when outside this repo
import { createNetServer } from '../../src/index.js';
import { registry, Position, Chopping, Mining, Owner, WORLD_TILES, TICK_MS } from '../shared.js';
import { em, chunks } from './entities.js';
import { generateWorld } from './world.js';
import { isWalkable } from './world.js';
import {
  addPlayer, removePlayer, getInterest,
  choppingSystem, miningSystem, npcWanderSystem, respawnSystem,
} from './systems.js';

// ── World ──────────────────────────────────────────────

generateWorld();
console.log(`World generated: ${WORLD_TILES}x${WORLD_TILES} tiles`);

// ── Server ──────────────────────────────────────────────

const server = createNetServer(em, registry, { port: 9001 }, undefined, {
  ownerComponent: { component: Owner, clientIdField: Owner.clientId },
});

server.validate(Position, {
  delta(_clientId, entityId, data) {
    const ox = em.get(entityId, Position.x) as number;
    const oy = em.get(entityId, Position.y) as number;
    const nx = data.x as number, ny = data.y as number;
    if (Math.abs(nx - ox) > 1 || Math.abs(ny - oy) > 1) return false;
    if (!isWalkable(nx, ny)) return false;
    chunks.move(entityId, ox, oy, nx, ny);
    return true;
  },
});

const adjacencyCheck = (_clientId: number, entityId: number, data: Record<string, unknown>) => {
  const px = em.get(entityId, Position.x) as number;
  const py = em.get(entityId, Position.y) as number;
  return Math.abs(px - (data.targetX as number)) <= 1 && Math.abs(py - (data.targetY as number)) <= 1;
};

server.validate(Chopping, { attach: adjacencyCheck, delta: adjacencyCheck });
server.validate(Mining,   { attach: adjacencyCheck, delta: adjacencyCheck });

server.onConnect = (clientId) => {
  addPlayer(clientId);
  console.log(`Client ${clientId} connected`);
};

server.onReconnect = (clientId) => {
  console.log(`Client ${clientId} reconnected`);
};

server.onDisconnect = (clientId) => {
  removePlayer(clientId);
  console.log(`Client ${clientId} disconnected`);
};

await server.start();
console.log(`Server listening on ws://localhost:9001 (${TICK_MS}ms tick)`);

// ── Game loop ──────────────────────────────────────────

setInterval(() => {
  choppingSystem();
  miningSystem();
  npcWanderSystem();
  respawnSystem();
  server.tick((cid) => getInterest(cid, server));
}, TICK_MS);
