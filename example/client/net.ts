import { createEntityManager } from 'archetype-ecs';
import { createNetClient } from '../../src/index.js';
import { registry, Owner } from '../shared.js';
import type { GameState } from './main.js';

const TOKEN_KEY = 'reconnectToken';

export const em = createEntityManager();
export const client = createNetClient(em, registry, {
  ownerComponent: { component: Owner, clientIdField: Owner.clientId },
});

function saveToken() {
  sessionStorage.setItem(TOKEN_KEY, String(client.reconnectToken));
}

export function connect(state: GameState) {
  // Restore token from previous session (survives page refresh)
  const saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved) client.reconnectToken = Number(saved);

  client.onConnected = () => { saveToken(); state.hud.textContent = 'Connected'; };
  client.onDisconnected = () => { state.hud.textContent = 'Disconnected — reconnecting...'; };
  client.onReconnected = () => { saveToken(); state.hud.textContent = 'Reconnected'; };
  client.connect('ws://localhost:9001');
}
