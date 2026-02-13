# RPG Demo

Tile-based multiplayer RPG with interest management and reconnect. Players move on a 64×64 procedural world, chop trees, mine rocks, and see NPCs wander. Each client only receives entities within view range. Disconnected players persist during the reconnect grace period.

```bash
npm run dev                        # starts game server + vite, opens browser
```

## File structure

```
shared.ts              Components, registry, constants (shared by server & client)
pathfinding.ts         BFS pathfinding on tile grid (shared by server & client)

server/
  main.ts              createNetServer, game loop, tick(filter)
  entities.ts          ECS entity manager + spawn/destroy helpers
  systems.ts           Game systems: chopping, mining, NPC wander, respawn, interest filter
  world.ts             Procedural world generation (tiles, trees, rocks, NPCs)
  chunks.ts            Spatial hash for chunk-based entity lookups

client/
  main.ts              State, resize, render loop
  net.ts               createNetClient + connect + reconnect token persistence
  input.ts             Click/touch → client-side pathfinding + movement
  renderer.ts          Canvas 2D tile + entity rendering (ECS queries)

client.html            Single-page HTML shell (vite transpiles .ts)
```

---

## Shared

`shared.ts` defines components and the registry. Both server and client need the same fields in the same order — the registry assigns stable wire IDs used in the binary protocol.

```ts
// shared.ts
import { component } from 'archetype-ecs'
import { createComponentRegistry } from 'archetype-ecs-net'

export const Position   = component('Pos',   'i16', ['x', 'y'])
export const EntityType = component('EType', 'u8',  ['kind'])
export const Health     = component('Hp',    'i16', ['current', 'max'])
export const Appearance = component('App',   'u8',  ['variant'])
export const Owner      = component('Own',   'u16', ['clientId'])
export const Chopping   = component('Chop',  'i16', ['targetX', 'targetY'])
export const Mining     = component('Mine',  'i16', ['targetX', 'targetY'])

export const registry = createComponentRegistry([
  { component: Position,   name: 'Position', clientOwned: true },  // wireId 0
  { component: EntityType, name: 'EntityType' },                   // wireId 1
  { component: Health,     name: 'Health' },                        // wireId 2
  { component: Appearance, name: 'Appearance' },                    // wireId 3
  { component: Owner,      name: 'Owner' },                         // wireId 4
  { component: Chopping,   name: 'Chopping', clientOwned: true },   // wireId 5
  { component: Mining,     name: 'Mining',   clientOwned: true },   // wireId 6
])
```

Everything is ECS — tiles, players, trees, rocks, NPCs. `Position`, `Chopping`, and `Mining` are `clientOwned` — the client writes to them directly, and the server validates via `server.validate()`. Interactions work by attaching a component: the client adds `Chopping` to start chopping, and the server's `choppingSystem` deals damage each tick.

---

## Server

### Spawning networked entities

Entities that should be synced over the network need the `Networked` tag. The library automatically tracks, diffs, and encodes any entity with this tag.

```ts
// server/entities.ts
import { Networked } from 'archetype-ecs-net'

// Tiles are entities too — interest management only sends nearby ones
export function spawnTile(x, y, tileType) {
  const eid = em.createEntityWith(
    Position, { x, y },
    EntityType, { kind: KIND_TILE },
    Appearance, { variant: tileType },
    Networked,                        // ← auto-synced to nearby clients
  )
  chunks.add(eid, x, y)
  return eid
}

// Players get Owner component. Position is clientOwned — the client moves directly.
export function spawnPlayer(x, y, clientId, variant) {
  const eid = em.createEntityWith(
    Position, { x, y },
    EntityType, { kind: KIND_PLAYER },
    Health, { current: 10, max: 10 },
    Appearance, { variant },
    Owner, { clientId },
    Networked,
  )
  chunks.add(eid, x, y)
  return eid
}
```

Destroying an entity (`em.destroyEntity(eid)`) automatically triggers a destroy message to all clients who knew about it.

### Creating the server

`createNetServer` wires up the ECS, registry, and transport. The `ownerComponent` option enables ownership validation — client deltas are rejected if `Owner.clientId` doesn't match the sender. `reconnectWindow` keeps the player entity alive during brief disconnects — `onDisconnect` only fires after the grace period expires.

```ts
// server/main.ts
import { createNetServer } from 'archetype-ecs-net'

const server = createNetServer(em, registry, { port: 9001, reconnectWindow: 10_000 }, undefined, {
  ownerComponent: { component: Owner, clientIdField: Owner.clientId },
})

server.validate(Position, {
  delta(_clientId, entityId, data) {
    const ox = em.get(entityId, Position.x), oy = em.get(entityId, Position.y)
    if (Math.abs(data.x - ox) > 1 || Math.abs(data.y - oy) > 1) return false
    if (!isWalkable(data.x, data.y)) return false
    chunks.move(entityId, ox, oy, data.x, data.y)
    return true
  },
})

server.validate(Chopping, {
  attach(_clientId, entityId, data) {
    const px = em.get(entityId, Position.x), py = em.get(entityId, Position.y)
    return Math.abs(px - data.targetX) <= 1 && Math.abs(py - data.targetY) <= 1
  },
  delta(_clientId, entityId, data) {
    const px = em.get(entityId, Position.x), py = em.get(entityId, Position.y)
    return Math.abs(px - data.targetX) <= 1 && Math.abs(py - data.targetY) <= 1
  },
})

server.onConnect = (clientId) => addPlayer(clientId)
server.onReconnect = (clientId) => console.log(`Client ${clientId} reconnected`)
server.onDisconnect = (clientId) => removePlayer(clientId)

await server.start()
```

Position changes are received and applied automatically — the `delta` handler runs before each update. Interactions are component-based: the client attaches `Chopping`/`Mining` and the server validates adjacency via the `attach` handler. On reconnect, the player entity and position are preserved — `onDisconnect` (and `removePlayer`) only fires when the grace period expires without reconnection.

### Game loop with interest management

The game loop runs systems, then calls `server.tick(filter)`. The filter function returns the set of netIds each client should see — entities entering/leaving a client's interest are sent as creates/destroys. This means each client only receives the ~625 nearby tiles instead of all 4096.

```ts
// server/main.ts
setInterval(() => {
  choppingSystem()
  miningSystem()
  npcWanderSystem()
  respawnSystem()

  server.tick((clientId) => getInterest(clientId, server))
}, TICK_MS)
```

### Interest filter

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

---

## Client

### Connecting with createNetClient

The browser client uses the same ECS and registry as the server. `createNetClient` handles all message dispatch internally — clientId assignment, full state, and deltas are all automatic. The `ownerComponent` option tells the client which entities it owns, so it only diffs and sends those.

```ts
// client/net.ts
import { createEntityManager } from 'archetype-ecs'
import { createNetClient } from 'archetype-ecs-net'
import { registry, Owner } from '../shared.js'

const TOKEN_KEY = 'reconnectToken'

export const em = createEntityManager()
export const client = createNetClient(em, registry, {
  ownerComponent: { component: Owner, clientIdField: Owner.clientId },
})

function saveToken() {
  sessionStorage.setItem(TOKEN_KEY, String(client.reconnectToken))
}

export function connect(state) {
  // Restore token from previous session (survives page refresh)
  const saved = sessionStorage.getItem(TOKEN_KEY)
  if (saved) client.reconnectToken = Number(saved)

  client.onConnected = () => { saveToken(); state.hud.textContent = 'Connected' }
  client.onDisconnected = () => { state.hud.textContent = 'Disconnected — reconnecting...' }
  client.onReconnected = () => { saveToken(); state.hud.textContent = 'Reconnected' }
  client.connect('ws://localhost:9001')
}
```

No manual message parsing. `client.clientId` and `client.netToEntity` are available immediately after connect. The `reconnectToken` property is persisted to `sessionStorage` so the session survives page refreshes — on reconnect, the same clientId is preserved and full state is re-synced.

The `ownedEntities` helper returns all entities owned by this client, replacing manual iteration over `netToEntity`:

```ts
// client/input.ts — find own player
const me = client.ownedEntities[0] ?? null

// client/renderer.ts — camera follows own player
const meEid = client.ownedEntities[0] ?? null
```

### Client-side movement

The client owns `Position` — it pathfinds locally using BFS, then moves one tile per tick by writing directly to the ECS. `client.tick()` diffs the Position changes and sends them to the server, where the `delta` validator checks walkability and max distance.

```ts
// client/input.ts
canvas.addEventListener('click', (e) => {
  const t = pointToTile(e.clientX, e.clientY, state)
  if (t) {
    const tileMap = buildTileMap(state)
    movePath = bfs(px, py, t.x, t.y, WORLD_TILES, (x, y) => isWalkable(tileMap, x, y))
  }
})

// Called from game loop — steps one tile per tick
function stepMovement(state, now) {
  if (movePath.length === 0) return
  const next = movePath.shift()
  state.em.set(me, Position.x, next.x)
  state.em.set(me, Position.y, next.y)
}
```

Interactions work by attaching clientOwned components. Right-click a tree → "Chop" → walk adjacent → attach `Chopping`. The server's `choppingSystem` reacts each tick:

```ts
// client/input.ts — right-click tree → "Chop" → walk adjacent → attach
handleClick(state, tile.x, tile.y, Chopping)  // component ref = interact
handleClick(state, tile.x, tile.y, null)       // null = just walk there

function attachAction(state, me, comp, tx, ty) {
  clearActions(state)  // remove any existing Chopping/Mining
  state.em.addComponent(me, comp, { targetX: tx, targetY: ty })
}
```

### Game loop

The game loop steps movement, diffs owned components, and renders:

```ts
// client/main.ts
function loop() {
  stepMovement(state, performance.now())
  client.tick()    // diff clientOwned components → send delta to server
  render(ctx, state)
  requestAnimationFrame(loop)
}
```

The server receives Position updates automatically and validates each step via `server.validate(Position, { delta })`. Chopping/Mining components are synced the same way — `client.tick()` sends attach/detach deltas, the server validates adjacency via `server.validate(Chopping, { attach })`, and per-tick systems deal damage.

---

## Controls

- **Click/tap** a tile to pathfind there
- **Right-click/long-press** a tree or rock for context menu (chop/mine)
