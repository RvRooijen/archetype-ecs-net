# RPG Demo

Tile-based multiplayer RPG with interest management. Players move on a 64x64 procedural world, chop trees, mine rocks, and see NPCs wander. Each client only receives entities within view range.

## Running

```bash
npm run build                      # build dist/ (needed for browser client imports)
npx tsx example/server/main.ts     # start server on ws://localhost:9001
```

Serve the project root with any static file server and open `example/client.html` in a browser.

## File structure

```
shared.ts              Components, registry, constants (shared by server & client)

server/
  main.ts              Entry point — createNetServer, game loop, tick(filter)
  entities.ts          ECS entity manager + spawn/destroy helpers
  systems.ts           Game systems: input, movement, NPC wander, respawn, interest filter
  world.ts             Procedural world generation (tiles, trees, rocks, NPCs)
  chunks.ts            Spatial hash for chunk-based entity lookups
  pathfinding.ts       BFS pathfinding on tile grid

client/
  main.js              Entry point — state, resize, render loop
  net.js               WebSocket connection, binary message dispatch
  protocol.js          Decode full state + apply deltas (uses dist/Protocol.js)
  input.js             Click/touch → move/interact commands
  renderer.js          Canvas 2D tile + entity rendering
  constants.js         Client-side constants

client.html            Single-page HTML shell
```

---

## Walkthrough

### 1. Shared components

`shared.ts` defines components and the registry. Both server and client need the same fields in the same order — the registry assigns stable wire IDs used in the binary protocol.

```ts
// shared.ts
import { component } from 'archetype-ecs'
import { createComponentRegistry } from 'archetype-ecs-net'

export const Position   = component('Pos',   'i16', ['x', 'y'])
export const EntityType = component('EType', 'u8',  ['kind'])
export const Health     = component('Hp',    'i16', ['current', 'max'])
export const Appearance = component('App',   'u8',  ['variant'])

export const registry = createComponentRegistry([
  { component: Position,   name: 'Position' },    // wireId 0
  { component: EntityType, name: 'EntityType' },   // wireId 1
  { component: Health,     name: 'Health' },        // wireId 2
  { component: Appearance, name: 'Appearance' },    // wireId 3
])
```

### 2. Spawning networked entities

Entities that should be synced over the network need the `Networked` tag. The library automatically tracks, diffs, and encodes any entity with this tag.

```ts
// server/entities.ts
import { Networked } from 'archetype-ecs-net'

export function spawnEntity(x, y, kind, hp, variant) {
  const eid = em.createEntityWith(
    Position, { x, y },
    EntityType, { kind },
    Health, { current: hp, max: hp },
    Appearance, { variant },
    Networked,                        // ← this is what makes it sync
  )
  chunks.add(eid, x, y)
  return eid
}
```

Destroying an entity (`em.destroyEntity(eid)`) automatically triggers a destroy message to all clients who knew about it.

### 3. Creating the server

`createNetServer` wires up the ECS, registry, and transport. Set up callbacks for connect, disconnect, and incoming messages.

```ts
// server/main.ts
import { createNetServer } from 'archetype-ecs-net'

const server = createNetServer(em, registry, { port: 9001 })

server.onConnect = (clientId) => {
  addPlayer(clientId)
  sendTileMap(clientId)           // custom message — see step 5
  pendingPlayerIds.add(clientId)  // defer player ID until netId is assigned
}

server.onDisconnect = (clientId) => {
  removePlayer(clientId)
}

server.onMessage = (clientId, data) => {
  queueInput(clientId, data)      // buffer inputs for processing in game loop
}

await server.start()
```

On connect, the client automatically receives a full state snapshot with all entities visible to them.

### 4. Game loop with interest management

The game loop runs systems, then calls `server.tick(filter)`. The filter function returns the set of netIds each client should see — entities entering/leaving a client's interest are sent as creates/destroys.

```ts
// server/main.ts
setInterval(() => {
  processInputs()
  movePlayers()
  npcWanderSystem()
  respawnSystem()

  server.tick((clientId) => getInterest(clientId, server))
}, TICK_MS)
```

### 5. Interest filter

The interest filter queries a spatial hash to find nearby entities, then maps entity IDs to netIds via `server.entityNetIds`.

```ts
// server/systems.ts
export function getInterest(clientId, server) {
  const eid = clientToPlayer.get(clientId)
  if (eid === undefined) return new Set()

  const px = em.get(eid, Position.x)
  const py = em.get(eid, Position.y)
  const interest = new Set()

  // Query chunks within VIEW_RANGE tiles
  const sets = chunks.queryRange(px, py, VIEW_RANGE, WORLD_TILES)
  for (const set of sets) {
    for (const nearby of set) {
      const ex = em.get(nearby, Position.x)
      const ey = em.get(nearby, Position.y)
      if (Math.abs(ex - px) <= VIEW_RANGE && Math.abs(ey - py) <= VIEW_RANGE) {
        const netId = server.entityNetIds.get(nearby)
        if (netId !== undefined) interest.add(netId)
      }
    }
  }
  return interest
}
```

### 6. Custom messages

`server.send()` lets you send application-level messages alongside the automatic entity sync. In this demo, tile map data and the player's own netId are sent as custom binary messages.

```ts
// server/main.ts
function sendTileMap(clientId) {
  const buf = new ArrayBuffer(2 + tileMap.length)
  const view = new DataView(buf)
  view.setUint8(0, 0xFE)           // MSG_TILE_MAP marker
  view.setUint8(1, WORLD_TILES)
  new Uint8Array(buf, 2).set(tileMap)
  server.send(clientId, buf)
}
```

NetIds are assigned during `tick()`, not during entity creation. So player IDs are sent after the first tick:

```ts
// server/main.ts — inside setInterval, after server.tick()
for (const clientId of pendingPlayerIds) {
  const eid = clientToPlayer.get(clientId)
  const netId = server.entityNetIds.get(eid)
  if (netId !== undefined) {
    sendPlayerId(clientId, netId)
    pendingPlayerIds.delete(clientId)
  }
}
```

### 7. Client — message dispatch

The client receives four message types on the same WebSocket. The first byte determines the type:

```js
// client/net.js
ws.onmessage = (e) => {
  const buf = e.data
  const type = new Uint8Array(buf)[0]

  if (type === 0xFE) {        // tile map (custom)
    const size = new Uint8Array(buf)[1]
    state.tileMap = new Uint8Array(buf, 2, size * size)
  } else if (type === 0xFD) { // player id (custom)
    state.myNetId = new DataView(buf).getUint16(1, true)
  } else if (type === 0x01) { // full state (archetype-ecs-net)
    state.entities = decodeFullState(buf)
  } else if (type === 0x02) { // delta (archetype-ecs-net)
    applyDelta(buf, state.entities)
  }
}
```

### 8. Client — decoding protocol messages

The browser client uses `ProtocolDecoder` from the built `dist/` directly. It defines a lightweight registry (no ECS dependency needed) that mirrors the server's field layout.

```js
// client/protocol.js
import { ProtocolDecoder } from '../../dist/Protocol.js'
import { MSG_FULL, MSG_DELTA } from '../../dist/types.js'

const decoder = new ProtocolDecoder()

const components = [
  { name: 'Position',   fields: [{ name: 'x', type: 'i16' }, { name: 'y', type: 'i16' }] },
  { name: 'EntityType', fields: [{ name: 'kind', type: 'u8' }] },
  { name: 'Health',     fields: [{ name: 'current', type: 'i16' }, { name: 'max', type: 'i16' }] },
  { name: 'Appearance', fields: [{ name: 'variant', type: 'u8' }] },
]
```

Full state replaces the entity map, deltas mutate it in place:

```js
// client/protocol.js
export function decodeFullState(buf) {
  const msg = decoder.decode(buf, registry)
  const result = new Map()
  for (const [netId, compMap] of msg.entities) {
    result.set(netId, entityFromCompMap(compMap))
  }
  return result
}

export function applyDelta(buf, entities) {
  const msg = decoder.decode(buf, registry)

  for (const [netId, compMap] of msg.created)    // new or entered view
    entities.set(netId, entityFromCompMap(compMap))

  for (const netId of msg.destroyed)              // removed or left view
    entities.delete(netId)

  for (const upd of msg.updated) {                // field changes
    const ent = entities.get(upd.netId)
    if (!ent) continue
    // apply partial fields based on upd.componentWireId and upd.data
  }
}
```

### 9. Client — sending input

Player input is encoded as compact binary messages (5–6 bytes) and sent to the server:

```js
// client/net.js
export function sendMove(state, tx, ty) {
  const buf = new ArrayBuffer(5)
  const v = new DataView(buf)
  v.setUint8(0, INPUT_MOVE)      // 1 byte: message type
  v.setInt16(1, tx, true)        // 2 bytes: target x
  v.setInt16(3, ty, true)        // 2 bytes: target y
  ws.send(buf)
}
```

The server queues these, then processes them in `processInputs()` at the start of each tick. Move commands trigger BFS pathfinding; interact commands check adjacency and execute actions (chop tree, mine rock).

## Controls

- **Click/tap** a tile to pathfind there
- **Right-click/long-press** a tree or rock for context menu (chop/mine)
