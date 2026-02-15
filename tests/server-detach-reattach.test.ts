/**
 * Regression test: client re-attach of clientOwned component after server-side detach.
 *
 * Scenario (DropAction pattern):
 * 1. Client adds clientOwned component (e.g. DropAction) → sent to server as attach
 * 2. Server processes it (e.g. dropSystem) and removes the component
 * 3. Server sends detach delta to client
 * 4. Client receives the detach, removes component locally
 * 5. Client adds the same component again → must be sent as a new attach
 *
 * Root cause: when a clientOwned component is added (via client delta) and removed
 * (by a server system) within the same tick, the differ sees the entity's archetype
 * go A→B→A and detects no change. The detach is never sent.
 *
 * Fix: server.tick() must run BEFORE systems, so the differ captures the client
 * delta changes (attach) first. The system then removes the component, and the
 * NEXT server.tick() captures the detach.
 *
 * Additionally, the client's prevOwnedPresence must be updated when the server
 * sends a detach for a clientOwned component, so the client's re-attach is
 * correctly detected as a new attach.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked } from '../src/DirtyTracker.js';
import { createNetServer } from '../src/NetServer.js';
import { createNetClient } from '../src/NetClient.js';
import { WebSocket as NodeWebSocket } from 'ws';

(globalThis as any).WebSocket = NodeWebSocket;

const Position = component('RaPos', 'f32', ['x', 'y']);
const Owner    = component('RaOwn', 'u16', ['clientId']);
const DropSlot = component('RaDrop', 'u8', ['slot']);  // clientOwned, like DropAction

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Owner,    name: 'Owner' },
  { component: DropSlot, name: 'DropSlot', clientOwned: true },
]);

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('server-side detach of clientOwned component', () => {
  it('differ misses attach+detach within same tick (demonstrates the bug)', async () => {
    const PORT = 19950 + Math.floor(Math.random() * 1000);

    const serverEm = createEntityManager();
    const server = createNetServer(serverEm, registry, { port: PORT }, undefined, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    let serverPlayerEid: number | undefined;
    server.onConnect = (clientId) => {
      serverPlayerEid = serverEm.createEntityWith(
        Position, { x: 0, y: 0 }, Owner, { clientId }, Networked,
      );
    };

    await server.start();
    server.tick();

    const clientEm = createEntityManager();
    const client = createNetClient(clientEm, registry, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await new Promise<void>(resolve => {
      client.onConnected = () => resolve();
      client.connect(`ws://localhost:${PORT}`);
    });

    server.tick();
    await wait(50);
    client.tick();
    client.tick(); // baseline

    const me = client.ownedEntities[0]!;

    // Client attaches DropSlot
    clientEm.addComponent(me, DropSlot, { slot: 3 });
    client.tick();
    await wait(50);

    assert.ok(serverEm.hasComponent(serverPlayerEid!, DropSlot), 'server has DropSlot');

    // BAD ordering: system removes THEN tick diffs → entity goes A→B→A → no change
    serverEm.removeComponent(serverPlayerEid!, DropSlot);
    server.tick();
    await wait(50);
    client.tick();

    // Client STILL has DropSlot because the detach was never sent!
    assert.ok(clientEm.hasComponent(me, DropSlot),
      'Bug: client still has DropSlot because differ missed A→B→A');

    client.disconnect();
    await server.stop();
  });

  it('re-attach works when server.tick() runs before systems (the fix)', async () => {
    const PORT = 19950 + Math.floor(Math.random() * 1000);

    const serverEm = createEntityManager();
    const server = createNetServer(serverEm, registry, { port: PORT }, undefined, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    let serverPlayerEid: number | undefined;
    server.onConnect = (clientId) => {
      serverPlayerEid = serverEm.createEntityWith(
        Position, { x: 0, y: 0 }, Owner, { clientId }, Networked,
      );
    };

    await server.start();
    server.tick();

    const clientEm = createEntityManager();
    const client = createNetClient(clientEm, registry, {
      ownerComponent: { component: Owner, clientIdField: Owner.clientId },
    });

    await new Promise<void>(resolve => {
      client.onConnected = () => resolve();
      client.connect(`ws://localhost:${PORT}`);
    });

    server.tick();
    await wait(50);
    client.tick();
    client.tick(); // baseline

    const me = client.ownedEntities[0]!;

    // ── First drop ──
    clientEm.addComponent(me, DropSlot, { slot: 3 });
    client.tick();
    await wait(50);

    assert.ok(serverEm.hasComponent(serverPlayerEid!, DropSlot), 'server has DropSlot');
    assert.equal(serverEm.get(serverPlayerEid!, DropSlot.slot), 3);

    // GOOD ordering: tick first (captures attach), THEN system removes
    server.tick(); // captures DropSlot attach, sends delta
    serverEm.removeComponent(serverPlayerEid!, DropSlot); // "dropSystem"

    // Next tick captures the detach
    server.tick();
    await wait(50);

    client.tick(); // processes attach echo + detach

    assert.ok(!clientEm.hasComponent(me, DropSlot),
      'Client should not have DropSlot after server detach');

    // ── Second drop ──
    clientEm.addComponent(me, DropSlot, { slot: 7 });
    client.tick();
    await wait(50);

    // Server should have DropSlot again
    assert.ok(serverEm.hasComponent(serverPlayerEid!, DropSlot),
      'Server should have DropSlot after second client attach');
    assert.equal(serverEm.get(serverPlayerEid!, DropSlot.slot), 7);

    // Clean up: server processes second drop
    server.tick();
    serverEm.removeComponent(serverPlayerEid!, DropSlot);
    server.tick();
    await wait(50);
    client.tick();

    assert.ok(!clientEm.hasComponent(me, DropSlot),
      'Client should not have DropSlot after second server detach');

    client.disconnect();
    await server.stop();
  });
});
