<p align="center">
  <br>
  <img src="https://em-content.zobj.net/source/apple/391/satellite-antenna_1f4e1.png" width="80" />
  <br><br>
  <strong>archetype-ecs-net</strong>
  <br>
  <sub>Binary delta sync over WebSocket for archetype-ecs.</sub>
  <br><br>
  <a href="https://www.npmjs.com/package/archetype-ecs-net"><img src="https://img.shields.io/npm/v/archetype-ecs-net.svg?style=flat-square&color=000" alt="npm" /></a>
  <a href="https://github.com/RvRooijen/archetype-ecs-net/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/archetype-ecs-net.svg?style=flat-square&color=000" alt="license" /></a>
</p>

---

Network layer for [archetype-ecs](https://github.com/RvRooijen/archetype-ecs). Tag entities with `Networked`, call `tick()` every frame — clients get binary deltas automatically.

```
npm i archetype-ecs-net
```

---

### The full picture in 30 lines

```ts
import { createEntityManager, component } from 'archetype-ecs'
import { createComponentRegistry, createNetServer, Networked } from 'archetype-ecs-net'

const Position = component('Position', { x: 'f32', y: 'f32' })
const Velocity = component('Velocity', { vx: 'f32', vy: 'f32' })

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Velocity, name: 'Velocity' },
])

const em = createEntityManager()

// Spawn networked entities
for (let i = 0; i < 1000; i++) {
  em.createEntityWith(
    Position, { x: Math.random() * 800, y: Math.random() * 600 },
    Velocity, { vx: 1, vy: 1 },
    Networked,
  )
}

const server = createNetServer(em, registry, { port: 9001 })
await server.start()

// Game loop
setInterval(() => {
  em.forEach([Position, Velocity], (a) => {
    const px = a.field(Position.x), py = a.field(Position.y)
    const vx = a.field(Velocity.vx), vy = a.field(Velocity.vy)
    for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i] }
  })
  server.tick()  // diff → encode → broadcast
}, 50)
```

Game systems don't need to change — `tick()` diffs the raw TypedArrays against a double-buffered snapshot.

---

### How it works

```
Game systems write to TypedArrays (front buffer)
            │
            ▼
     server.tick()
            │
     ┌──────┴──────┐
     │  diff front  │   Compare front[i] !== back[i] per field
     │  vs back     │   Only iterates Networked archetypes
     └──────┬──────┘
            │
     ┌──────┴──────┐
     │   encode     │   Binary protocol: u8 wire IDs, field bitmasks
     └──────┬──────┘
            │
     ┌──────┴──────┐
     │  broadcast   │   WebSocket binary frames
     └──────┬──────┘
            │
     ┌──────┴──────┐
     │  flush       │   .set() memcpy front → back per field
     └─────────────┘
```

Each tracked archetype keeps a back-buffer copy of its TypedArrays. `flushSnapshots()` copies front→back with `.set()` per field.

---

### Client

```ts
import { createEntityManager, component } from 'archetype-ecs'
import { createComponentRegistry, createNetClient } from 'archetype-ecs-net'

// Same components, same registration order as server
const Position = component('Position', { x: 'f32', y: 'f32' })
const Velocity = component('Velocity', { vx: 'f32', vy: 'f32' })

const registry = createComponentRegistry([
  { component: Position, name: 'Position' },
  { component: Velocity, name: 'Velocity' },
])

const em = createEntityManager()
const client = createNetClient(em, registry)

client.onConnected = () => console.log('connected')
client.connect('ws://localhost:9001')

// On connect: receives full state snapshot
// Every tick: receives binary delta, auto-applied to local EM
```

The client uses the browser `WebSocket` API — no server-side dependencies needed client-side.

---

### Component registry

Both server and client must register the same components in the same order. This assigns stable `u8` wire IDs (0–255) used in the binary protocol. Each component supports up to 16 fields (u16 bitmask).

```ts
const registry = createComponentRegistry([
  { component: Position, name: 'Position' },   // wireId 0
  { component: Velocity, name: 'Velocity' },   // wireId 1
  { component: Health,   name: 'Health' },      // wireId 2
])
```

Field types are introspected from the component schema — `f32`, `i32`, `string`, etc. — and encoded with their native byte size on the wire.

---

### Networked tag

Only entities with the `Networked` tag component are tracked and synced:

```ts
import { Networked } from 'archetype-ecs-net'

// This entity is synced
em.createEntityWith(Position, { x: 0, y: 0 }, Networked)

// This entity is local-only
em.createEntityWith(Position, { x: 0, y: 0 })
```

Removing the `Networked` tag triggers a destroy on all clients. Adding it triggers a create.

---

### Binary protocol

Binary format. Field values are written with their native byte size, no JSON encoding.

**Full state** (sent on client connect):
```
[u8 0x01] [u32 registryHash] [u16 entityCount]
  for each: [varint netId] [u8 componentCount]
    for each: [u8 wireId] [field values in schema order]
```

**Delta** (sent every tick):
```
[u8 0x02]
  [u16 createdCount]  → varint netId + full component data per entity
  [u16 destroyedCount] → varint netIds only
  [u16 updatedEntityCount]
    for each: [varint netId] [u8 compCount]
      for each: [u8 wireId] [u16 fieldMask] [changed field values]
```

Network IDs (`netId`) are varint-encoded (LEB128) — 1 byte for IDs < 128, 2 bytes for < 16K. Updates are grouped per entity to avoid repeating the netId for each dirty component. The wire protocol uses stable netIds instead of raw entity IDs; the client maintains a `netId → localEntityId` mapping.

Only changed fields are sent per entity — if only `Position.x` changed, `Position.y` stays off the wire.

---

### Pluggable transport

Default transport uses `ws`. You can provide your own `ServerTransport`:

```ts
import { createNetServer, createWsTransport } from 'archetype-ecs-net'

// Default
const server = createNetServer(em, registry, { port: 9001 })

// Custom transport
const server = createNetServer(em, registry, { port: 9001 }, myTransport)
```

```ts
interface ServerTransport {
  start(port: number, handlers: TransportHandlers): Promise<void>
  stop(): Promise<void>
  send(clientId: ClientId, data: ArrayBuffer): void
  broadcast(data: ArrayBuffer): void
}
```

---

### Example

**[RPG demo](example/)** — Full RPG with interest management, pathfinding, chunk-based visibility

```bash
npm run build                          # build dist/ for browser imports
npx tsx example/server/main.ts         # start server
# open example/client.html in browser (serve from project root)
```

---

## Benchmarks

1M entities across 4 archetypes (Players 50k/6c, Projectiles 250k/3c, NPCs 100k/5c, Static 600k/2c), 6 registered components, 3 game systems per tick. Termux/Android (aarch64):

| Test | ms/frame | overhead | wire |
|---|---:|---:|---:|
| Raw game tick (1M, 4 archetypes) | 3.51 | baseline | |
| + diffAndEncode (4k networked, 1%) | 5.59 | +2.08ms | 97 KB |
| + diffAndEncode (40k networked, 10%) | 23.96 | +20.45ms | 995 KB |

`diffAndEncode()` diffs and encodes in a single fused pass — no intermediate allocations, varint netIds, updates grouped per entity. At 1% networked (4k entities), the total overhead is 2.1ms — well within a 60fps budget.

Run them yourself:

```bash
npx tsx bench/net-bench.ts
```

---

## API reference

### `createComponentRegistry(registrations)`

Create a registry mapping components to wire IDs. Must be identical on server and client.

### `Networked`

Tag component. Add to any entity that should be synced over the network.

### `createNetServer(em, registry, config, transport?)`

Create a network server that diffs and broadcasts on every `tick()`.

| Method / Property | Description |
|---|---|
| `start()` | Start listening on configured port |
| `stop()` | Stop server, disconnect all clients |
| `tick(filter?)` | Diff → encode → send. No filter = broadcast. With filter = per-client interest |
| `send(clientId, data)` | Send a custom message to a specific client |
| `clientCount` | Number of connected clients |
| `entityNetIds` | `ReadonlyMap<EntityId, number>` — entity → netId mapping |
| `onConnect` | Callback when client connects (receives full state) |
| `onDisconnect` | Callback when client disconnects |
| `onMessage` | Callback when client sends a message |

The `filter` parameter is an `InterestFilter: (clientId) => ReadonlySet<number>` that returns the set of netIds visible to that client. Entities entering/leaving a client's interest set are sent as creates/destroys.

### `createNetClient(em, registry)`

Create a client that connects via WebSocket and auto-applies received state.

| Method / Property | Description |
|---|---|
| `connect(url)` | Connect to server |
| `disconnect()` | Close connection |
| `connected` | Whether currently connected |
| `onConnected` | Callback on successful connection |
| `onDisconnected` | Callback on disconnect |

---

## License

MIT
