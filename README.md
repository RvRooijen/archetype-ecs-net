<p align="center">
  <br>
  <img src="https://em-content.zobj.net/source/apple/391/satellite-antenna_1f4e1.png" width="80" />
  <br><br>
  <strong>archetype-ecs-net</strong>
  <br>
  <sub>Binary delta sync over WebSocket for archetype-ecs. Zero-copy diffing.</sub>
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
    Networked, {},
  )
}

const server = createNetServer(em, registry, { port: 9001 })
await server.start()

// Game loop — systems write directly to TypedArrays, zero overhead
setInterval(() => {
  em.forEach([Position, Velocity], (a) => {
    const px = a.field(Position.x), py = a.field(Position.y)
    const vx = a.field(Velocity.vx), vy = a.field(Velocity.vy)
    for (let i = 0; i < a.count; i++) { px[i] += vx[i]; py[i] += vy[i] }
  })
  server.tick()  // diff → encode → broadcast
}, 50)
```

No wrappers, no proxies, no `set()` calls. Your game systems stay exactly the same — `tick()` diffs the raw TypedArrays against a double-buffered snapshot.

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

**Double-buffered snapshots** live inside the core ECS. Each tracked archetype maintains a back-buffer copy of its TypedArrays. `flushSnapshots()` copies front→back with a single `.set()` (memcpy) per field — no per-entity overhead.

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

The client uses the standard browser `WebSocket` API — no server-side dependencies needed client-side.

---

### Component registry

Both server and client must register the same components in the same order. This assigns stable `u8` wire IDs (0–255) used in the binary protocol.

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
em.createEntityWith(Position, { x: 0, y: 0 }, Networked, {})

// This entity is local-only
em.createEntityWith(Position, { x: 0, y: 0 })
```

Removing the `Networked` tag triggers a destroy on all clients. Adding it triggers a create.

---

### Binary protocol

Compact binary format — no JSON, no strings on the wire for field data.

**Full state** (sent on client connect):
```
[u8 0x01] [u16 entityCount]
  for each: [u32 entityId] [u8 componentCount]
    for each: [u8 wireId] [field values in schema order]
```

**Delta** (sent every tick):
```
[u8 0x02]
  [u16 createdCount]  → full component data per entity
  [u16 destroyedCount] → entity IDs only
  [u16 updatedCount]  → entity ID + wire ID + field bitmask + changed values
```

Field bitmasks mean only changed fields are sent — if only `Position.x` changed, `Position.y` stays off the wire.

---

### Pluggable transport

The default transport uses the `ws` package. Bring your own by implementing `ServerTransport`:

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

### Using the differ directly

For custom networking setups, use `createSnapshotDiffer` and the protocol encoder/decoder directly:

```ts
import { createSnapshotDiffer, Networked, ProtocolEncoder, ProtocolDecoder } from 'archetype-ecs-net'

const differ = createSnapshotDiffer(em, registry)
const encoder = new ProtocolEncoder()
const decoder = new ProtocolDecoder()

// First diff establishes baseline (returns all Networked entities as "created")
differ.diff()

// Game loop
const delta = differ.diff()
const buffer = encoder.encodeDelta(delta, em, registry)
// → send buffer to clients

// On receive
const msg = decoder.decode(buffer, registry)
```

---

## Benchmarks

100k entities, Position += Velocity, Termux/Android (aarch64):

| Test | ms/frame | overhead |
|---|---:|---:|
| Raw ECS forEach (100k) | 0.33 | baseline |
| forEach + diff (1k networked) | 0.81 | +0.48ms |
| forEach + diff + encode (1k networked) | 1.57 | +1.24ms |
| forEach + diff (100k networked, worst) | 86.8 | +86.5ms |

The 1% case (1k networked out of 100k total) adds **< 0.5ms** of diff overhead per frame. Game systems run at full speed — direct TypedArray writes, no `set()` interception.

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

### `createSnapshotDiffer(em, registry)`

Create a differ that compares the current ECS state against a double-buffered snapshot. Returns a `SnapshotDiffer` with a single method:

| Method | Description |
|---|---|
| `diff()` | Compare front vs back buffers, return `Delta`, flush snapshots |

### `createNetServer(em, registry, config, transport?)`

Create a network server that diffs and broadcasts on every `tick()`.

| Method / Property | Description |
|---|---|
| `start()` | Start listening on configured port |
| `stop()` | Stop server, disconnect all clients |
| `tick()` | Diff → encode → broadcast delta to all clients |
| `clientCount` | Number of connected clients |
| `onConnect` | Callback when client connects (receives full state) |
| `onDisconnect` | Callback when client disconnects |

### `createNetClient(em, registry)`

Create a client that connects via WebSocket and auto-applies received state.

| Method / Property | Description |
|---|---|
| `connect(url)` | Connect to server |
| `disconnect()` | Close connection |
| `connected` | Whether currently connected |
| `onConnected` | Callback on successful connection |
| `onDisconnected` | Callback on disconnect |

### `ProtocolEncoder` / `ProtocolDecoder`

Low-level binary codec. Pre-allocated write buffer, grows as needed.

| Method | Description |
|---|---|
| `encoder.encodeFullState(em, registry)` | Encode all Networked entities → `ArrayBuffer` |
| `encoder.encodeDelta(delta, em, registry)` | Encode delta → `ArrayBuffer` |
| `decoder.decode(buffer, registry)` | Decode → `FullStateMessage \| DeltaMessage` |

---

## License

MIT
