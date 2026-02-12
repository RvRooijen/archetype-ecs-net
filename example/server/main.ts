// Use 'archetype-ecs-net' when outside this repo
import { createNetServer } from '../../src/index.js';
import { registry, WORLD_TILES, TICK_MS, MSG_TILE_MAP, MSG_PLAYER_ID } from '../shared.js';
import { em } from './entities.js';
import { tileMap, generateWorld } from './world.js';
import {
  addPlayer, removePlayer, queueInput, clientToPlayer, getInterest,
  processInputs, movePlayers, npcWanderSystem, respawnSystem,
} from './systems.js';
import type { ClientId } from '../../src/index.js';

// ── World ──────────────────────────────────────────────

generateWorld();
console.log(`World generated: ${WORLD_TILES}x${WORLD_TILES} tiles`);

// ── Server ──────────────────────────────────────────────

const server = createNetServer(em, registry, { port: 9001 });

// NetIds are assigned during tick(), so we defer sending player IDs
const pendingPlayerIds = new Set<ClientId>();

function sendTileMap(clientId: ClientId) {
  const buf = new ArrayBuffer(2 + tileMap.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_TILE_MAP);
  view.setUint8(1, WORLD_TILES);
  new Uint8Array(buf, 2).set(tileMap);
  server.send(clientId, buf);
}

function sendPlayerId(clientId: ClientId, netId: number) {
  const buf = new ArrayBuffer(3);
  const view = new DataView(buf);
  view.setUint8(0, MSG_PLAYER_ID);
  view.setUint16(1, netId, true);
  server.send(clientId, buf);
}

server.onConnect = (clientId) => {
  addPlayer(clientId);
  sendTileMap(clientId);
  pendingPlayerIds.add(clientId);
  console.log(`Client ${clientId} connected`);
};

server.onDisconnect = (clientId) => {
  removePlayer(clientId);
  pendingPlayerIds.delete(clientId);
  console.log(`Client ${clientId} disconnected`);
};

server.onMessage = (clientId, data) => {
  queueInput(clientId, data);
};

await server.start();
console.log(`Server listening on ws://localhost:9001 (${TICK_MS}ms tick)`);

// ── Game loop ──────────────────────────────────────────

setInterval(() => {
  processInputs();
  movePlayers();
  npcWanderSystem();
  respawnSystem();
  server.tick((cid) => getInterest(cid, server));

  // Send deferred player IDs (netIds are now assigned after tick)
  for (const clientId of pendingPlayerIds) {
    const eid = clientToPlayer.get(clientId);
    if (eid === undefined) continue;
    const netId = server.entityNetIds.get(eid);
    if (netId !== undefined) {
      sendPlayerId(clientId, netId);
      pendingPlayerIds.delete(clientId);
      console.log(`  → player netId=${netId}`);
    }
  }
}, TICK_MS);
