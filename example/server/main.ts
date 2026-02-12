// Use 'archetype-ecs-net' when outside this repo
import { createWsTransport } from '../../src/index.js';
import { WORLD_TILES, TICK_MS, MSG_TILE_MAP, MSG_PLAYER_ID } from '../shared.js';
import { entityToNetId, getNetId } from './entities.js';
import { tileMap, generateWorld } from './world.js';
import {
  addPlayer, removePlayer, queueInput,
  processInputs, movePlayers, npcWanderSystem, respawnSystem, sendStateToClients,
} from './systems.js';
import type { ClientId } from '../../src/index.js';

// ── World ──────────────────────────────────────────────

generateWorld();
console.log(`World generated: ${WORLD_TILES}x${WORLD_TILES} tiles, ${entityToNetId.size} entities`);

// ── Transport ──────────────────────────────────────────

const transport = createWsTransport();

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

await transport.start(9001, {
  onOpen(clientId) {
    const eid = addPlayer(clientId);
    sendTileMap(clientId);
    sendPlayerId(clientId, getNetId(eid));
    console.log(`Client ${clientId} connected (player netId=${getNetId(eid)})`);
  },

  onClose(clientId) {
    removePlayer(clientId);
    console.log(`Client ${clientId} disconnected`);
  },

  onMessage(clientId, data) {
    queueInput(clientId, data);
  },
});

console.log(`Server listening on ws://localhost:9001 (${TICK_MS}ms tick)`);

// ── Game loop ──────────────────────────────────────────

setInterval(() => {
  processInputs();
  movePlayers();
  npcWanderSystem();
  respawnSystem();
  sendStateToClients(transport);
}, TICK_MS);
