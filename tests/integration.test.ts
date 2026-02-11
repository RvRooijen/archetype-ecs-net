import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityManager, component } from 'archetype-ecs';
import { createComponentRegistry } from '../src/ComponentRegistry.js';
import { Networked } from '../src/DirtyTracker.js';
import { createNetServer } from '../src/NetServer.js';
import { ProtocolDecoder } from '../src/Protocol.js';
import { MSG_FULL, MSG_DELTA } from '../src/types.js';
import type { FullStateMessage, DeltaMessage } from '../src/types.js';
import WebSocket from 'ws';

const Position = component('NetPos', 'f32', ['x', 'y']);
const Health = component('NetHp', 'i32', ['hp', 'maxHp']);
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Health, name: 'Health' },
]);
const decoder = new ProtocolDecoder();

function recv(ws: WebSocket): Promise<ArrayBuffer> {
  return new Promise(r => ws.once('message', (d: Buffer) =>
    r(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))));
}

it('server: full state, delta updates, create, destroy, multi-client', async () => {
  const em = createEntityManager();
  const server = createNetServer(em, registry, { port: 19920 });

  // Pre-create entity — use em directly, add Networked tag
  const e1 = em.createEntityWith(Position, { x: 10, y: 20 }, Health, { hp: 100, maxHp: 100 }, Networked);
  server.tick(); // baseline snapshot — assigns netId=1

  await server.start();

  // ── 1. Full state on connect ──────────────────────────
  const ws1 = new WebSocket('ws://localhost:19920');
  const full = decoder.decode(await recv(ws1), registry) as FullStateMessage;

  assert.equal(full.type, MSG_FULL);
  assert.equal(full.entities.size, 1);
  // Look up by netId=1 (not entity ID)
  const e1Pos = full.entities.get(1)!.get(0)!;
  assert.ok(Math.abs((e1Pos.x as number) - 10) < 0.01);
  const e1Hp = full.entities.get(1)!.get(1)!;
  assert.equal(e1Hp.hp, 100);

  // ── 2. Delta field update ─────────────────────────────
  em.set(e1, Position.x, 42.5); // direct em.set, no wrapper
  let p = recv(ws1);
  server.tick(); // snapshot diff detects the change

  let delta = decoder.decode(await p, registry) as DeltaMessage;
  assert.equal(delta.type, MSG_DELTA);
  assert.equal(delta.updated.length, 1);
  assert.equal(delta.updated[0].netId, 1);
  assert.ok(Math.abs((delta.updated[0].data.x as number) - 42.5) < 0.01);
  assert.equal(delta.updated[0].data.y, undefined); // y not changed

  // ── 3. Entity creation in delta ───────────────────────
  em.createEntityWith(Position, { x: 99, y: 88 }, Networked);
  p = recv(ws1);
  server.tick();

  delta = decoder.decode(await p, registry) as DeltaMessage;
  assert.equal(delta.created.size, 1);
  // New entity gets netId=2
  const e2Pos = delta.created.get(2)!.get(0)!;
  assert.ok(Math.abs((e2Pos.x as number) - 99) < 0.01);

  // ── 4. Entity destruction in delta ────────────────────
  em.destroyEntity(e1);
  p = recv(ws1);
  server.tick();

  delta = decoder.decode(await p, registry) as DeltaMessage;
  assert.equal(delta.destroyed.length, 1);
  assert.equal(delta.destroyed[0], 1); // netId=1

  // ── 5. Multiple clients receive same delta ────────────
  const ws2 = new WebSocket('ws://localhost:19920');
  await recv(ws2); // full state

  assert.equal(server.clientCount, 2);

  // e1 is destroyed, e2 (netId=2) still exists — update it
  // Need to get the entity ID of the second entity
  const remaining = em.getAllEntities();
  const e2Id = remaining[0]; // the one still alive
  em.set(e2Id, Position.y, 77);
  const p1 = recv(ws1);
  const p2 = recv(ws2);
  server.tick();

  const [b1, b2] = await Promise.all([p1, p2]);
  const m1 = decoder.decode(b1, registry) as DeltaMessage;
  const m2 = decoder.decode(b2, registry) as DeltaMessage;
  assert.equal(m1.updated[0].netId, 2);
  assert.ok(Math.abs((m1.updated[0].data.y as number) - 77) < 0.01);
  assert.equal(m2.updated[0].netId, 2);
  assert.ok(Math.abs((m2.updated[0].data.y as number) - 77) < 0.01);

  // ── Cleanup ───────────────────────────────────────────
  ws1.terminate();
  ws2.terminate();
  await server.stop();
});
