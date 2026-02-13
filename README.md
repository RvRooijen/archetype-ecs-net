<p align="center">
  <br>
  <img src="https://raw.githubusercontent.com/RvRooijen/archetype-ecs-net/master/logo.svg" width="140" />
  <br><br>
  <strong>archetype-ecs-net</strong>
  <br>
  <sub>Multiplayer networking for archetype-ecs.</sub>
  <br><br>
  <a href="https://www.npmjs.com/package/archetype-ecs-net"><img src="https://img.shields.io/npm/v/archetype-ecs-net.svg?style=flat-square&color=00c853" alt="npm" /></a>
  <a href="https://github.com/RvRooijen/archetype-ecs-net/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/archetype-ecs-net.svg?style=flat-square&color=2979ff" alt="license" /></a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/RvRooijen/archetype-ecs-net/master/divider.svg" width="1000" /></p>

> [!NOTE]
> ## Foreword
>
> Multiplayer! At my game design study there was no teacher who could teach about the subject, That's when i learned that realtime polling a database every frame will get you a lot of DNS attack mails from your hosting provider. Oops.
> Since then i've tried a lot of other frameworks and network layers inside of engines.
>
> I bundled all my knowledge that i've gathered over the years in the [archetype-ecs](https://github.com/RvRooijen/archetype-ecs) package and this one. I hope you enjoy using it as much as I do :).

<p align="center"><img src="https://raw.githubusercontent.com/RvRooijen/archetype-ecs-net/master/divider.svg" width="1000" /></p>

Network layer for [archetype-ecs](https://github.com/RvRooijen/archetype-ecs). Tag entities with `Networked`, call `tick()` every frame — clients automatically receive only what changed.

```
npm i archetype-ecs-net
```

## Quick start

Players move with arrow keys, server applies gravity. Both sides share the same component definitions.

**shared.ts**
```ts
import { component } from 'archetype-ecs'
import { createComponentRegistry } from 'archetype-ecs-net'

export const Position = component('Pos', 'f32', ['x', 'y'])
export const Owner    = component('Own', 'u16', ['clientId'])

export const registry = createComponentRegistry([
  { component: Position, name: 'Position', clientOwned: true },
  { component: Owner,    name: 'Owner' },
])
```

**server.ts**
```ts
import { createEntityManager } from 'archetype-ecs'
import { createNetServer, Networked } from 'archetype-ecs-net'
import { Position, Owner, registry } from './shared'

const em = createEntityManager()
const server = createNetServer(em, registry, { port: 9001 })

server.onConnect = (clientId) => {
  em.createEntityWith(Position, { x: 0, y: 0 }, Owner, { clientId }, Networked)
}

await server.start()

setInterval(() => {
  em.forEach([Position], (a) => {
    const y = a.field(Position.y)
    for (let i = 0; i < a.count; i++) y[i] += 0.5  // gravity
  })
  server.tick()
}, 50)
```

**client.ts**
```ts
import { createEntityManager } from 'archetype-ecs'
import { createNetClient } from 'archetype-ecs-net'
import { Position, Owner, registry } from './shared'

const em = createEntityManager()
const client = createNetClient(em, registry, {
  ownerComponent: { component: Owner, clientIdField: Owner.clientId },
})
client.connect('ws://localhost:9001')

document.addEventListener('keydown', (e) => {
  const eid = client.ownedEntities[0]
  if (eid === undefined) return
  if (e.key === 'ArrowRight') em.set(eid, Position.x, em.get(eid, Position.x) + 5)
  if (e.key === 'ArrowLeft')  em.set(eid, Position.x, em.get(eid, Position.x) - 5)
})

function loop() {
  client.tick()
  em.forEach([Position], (a) => {
    const px = a.field(Position.x), py = a.field(Position.y)
    for (let i = 0; i < a.count; i++) drawPlayer(px[i], py[i])
  })
  requestAnimationFrame(loop)
}
loop()
```

For a full working project, see the **[RPG demo](example/)** — multiplayer RPG with pathfinding and chunk-based visibility.

```bash
npm run dev                            # starts game server + vite, opens browser
```

<p align="center"><img src="https://raw.githubusercontent.com/RvRooijen/archetype-ecs-net/master/divider.svg" width="1000" /></p>

## Wire protocol

Binary format. Field values are written with their native byte size, no JSON.

**Full state** (sent on connect):
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
  [u16 attachedEntityCount]
    for each: [varint netId] [u8 wireCount]
      for each: [u8 wireId] [field values in schema order]
  [u16 detachedEntityCount]
    for each: [varint netId] [u8 wireCount]
      for each: [u8 wireId]
```

**Client delta** (sent by client for `clientOwned` components):
```
[u8 0x03]
  [u16 updatedEntityCount]
    for each: [varint netId] [u8 compCount]
      for each: [u8 wireId] [u16 fieldMask] [changed field values]
  [u16 attachedEntityCount]
    for each: [varint netId] [u8 wireCount]
      for each: [u8 wireId] [field values in schema order]
  [u16 detachedEntityCount]
    for each: [varint netId] [u8 wireCount]
      for each: [u8 wireId]
```

**Reconnect handshake** (sent by client on WS open):
```
[u8 0x04] [u32 token]       token=0 for new client, nonzero to resume
```

**Client ID** (sent by server after handshake):
```
[u8 0xFF] [u16 clientId] [u32 token]
```

> [!NOTE]
> NetIds use varint encoding (1 byte for IDs < 128, 2 bytes for < 16K). Only changed fields are sent — if only `Position.x` changed, `Position.y` is not included. The attached/detached sections track `addComponent()` and `removeComponent()` calls automatically.

## Encoding strategy

archetype-ecs stores each component field as a flat TypedArray (one `Float32Array` per field, per archetype). archetype-ecs-net uses this to diff and encode in a single pass, without allocating temporary objects.

**Double buffering** — Each networked field keeps two arrays: the current values and a copy of what was last sent. On `tick()`, the library compares them element by element — `front[i] !== back[i]` — which is a simple loop over flat arrays with no property lookups or object traversal.

**Single-pass diff+encode** — Most serializers first collect what changed, then serialize it in a second step. archetype-ecs-net does both in one loop: when a value differs, it is written directly into the output buffer. No intermediate lists or objects are created.

This means:
- **No garbage collection pauses** — nothing is allocated per tick, so GC doesn't interrupt your game loop.
- **Fast iteration** — reading sequential TypedArray elements is fast because the data is contiguous in memory. Libraries that store state in JS objects (Colyseus, nengi, Javelin) follow pointers across the heap, which is slower at scale.
- **Linear scaling** — cost is proportional to networked entities only. At 1% networked (10k of 2M), the overhead is 1.1ms. See [Benchmarks](#benchmarks) below.

> [!IMPORTANT]
> Components must be flat fields (no nested objects). Supported types: `f32`, `f64`, `i8`, `i16`, `i32`, `u8`, `u16`, `u32`, and variable-length `string`.

## Benchmarks

Two benchmarks measure the two main costs: **diffing/encoding** all changed entities, and **per-client interest management** (computing what each client should see).

### Delta encoding overhead

Measures the cost `diffAndEncode()` adds on top of your game logic. The benchmark creates 2M entities across 6 archetypes, runs 5 game systems, then diffs and encodes the networked subset. The "overhead" column is the difference versus a raw game tick without networking.

Most games network 1–10% of their entities (the rest are local: tiles, particles, UI). The 50% and 100% rows are stress tests.

2M entities, 6 archetypes, 8 components, 5 systems. WSL2/x86-64:

| Test | ms/frame | overhead | wire |
|---|---:|---:|---:|
| Raw game tick (2M, 6 archetypes) | 10.42 | baseline | |
| + diffAndEncode (10k networked, 1%) | 11.55 | +1.13ms | 275 KB |
| + diffAndEncode (100k networked, 10%) | 33.58 | +23.15ms | 2.8 MB |
| + diffAndEncode (500k networked, 50%) | 185.0 | +174.6ms | 13.9 MB |
| + diffAndEncode (1M networked, 100%) | 428.4 | +418.0ms | 27.8 MB |

> [!TIP]
> At 1% networked (10k entities), the overhead is **1.1ms** — well within a 60fps budget.

### Interest management

Measures the cost of `tick(filter)` when each client sees a different subset of the world. The benchmark creates 8k networked entities (5k players, 2k NPCs, 1k mobs) with up to 5000 clients.

Clients that see the same set of entities share the same encoded buffer. With full visibility all 5000 clients share 1 buffer. With 50% visibility there are 2 groups, with 10% there are 10. Encoding runs once per group, not once per client.

8k entities, up to 5000 clients. WSL2/x86-64:

| Scenario | Clients | Groups | Total | Wire/client |
|---|---:|---:|---:|---:|
| Full visibility | 5000 | 1 | 7.4ms | 185 KB |
| Full + unique HP | 5000 | 1 | 8.8ms | 219 KB |
| 50% visibility | 5000 | 2 | 10.1ms | 92 KB |
| 10% visibility | 5000 | 10 | 10.1ms | 19 KB |

> [!NOTE]
> Even at 5000 clients, the total tick overhead stays under **11ms**. Wire size per client scales linearly with visibility — 10% view = ~10% of full wire size.

### Run

```bash
npx tsx bench/net-bench.ts
npx tsx bench/interest-bench.ts
```

<p align="center"><img src="https://raw.githubusercontent.com/RvRooijen/archetype-ecs-net/master/divider.svg" width="1000" /></p>

## Comparison

How archetype-ecs-net compares to other JS/TS multiplayer networking packages:

| Feature | archetype-ecs-net | [Colyseus](https://colyseus.io/) | [nengi](https://github.com/timetocode/nengi) | [Javelin](https://github.com/3mcd/javelin) |
|---|:---:|:---:|:---:|:---:|
| Built-in ECS | Yes | No | No | Yes |
| Protocol | Custom binary (varint, field bitmasks) | Custom binary (`@colyseus/schema`) | Binary WebSocket (byte-level) | ArrayBuffer serialization |
| Encoding strategy | [Single-pass diff+encode over TypedArrays](#encoding-strategy) | Tracks property mutations | Snapshot deltas | Schema-based encode/decode |
| Binary delta sync | Yes | Yes | Yes | Yes |
| TypedArray / SoA storage | Yes | No (plain objects) | No (plain objects) | Optional |
| Interest management | Yes | No | View culling | No |
| Delta grouping (dedup) | Yes | No | Partial | No |
| Reconnect support | Yes | Yes | No | No |
| Published benchmarks | Up to 2M entities | [Encoding ops/sec only](https://github.com/colyseus/schema/tree/master/benchmark) | Claims only | [ECS iteration only](https://javelin.games/ecs/performance/) |

**Notes:**
- Colyseus benchmarks ~1.3M encode ops/sec on individual objects but doesn't publish numbers for diffing thousands of entities per tick. Schemas are limited to 64 fields.
- nengi claims 100–400 players and 10k+ entities on a 20-tick server but doesn't publish per-tick timing. Max 65,536 entities.
- Javelin iterates ~2.5M entities/16ms for ECS, but its networking layer has no published benchmarks and uses plain JS objects by default.
- archetype-ecs-net adds **1.1ms** to diff+encode 10k entities (1% of 2M) and handles **5000 clients in under 11ms**. See [Benchmarks](#benchmarks).

### Industry context

The architecture follows patterns proven in shipped titles:

- **[Overwatch](https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and)** — ECS with server authority, client prediction, and delta sync. Timothy Ford's GDC 2017 talk covers the architecture.
- **[Unity Netcode for Entities](https://docs.unity3d.com/Packages/com.unity.netcode@1.0/manual/index.html)** — ECS-based networking with snapshot deltas and interest management. Used in IXION, Hardspace: Shipbreaker, and Diplomacy is Not an Option.
- **[SpatialOS](https://www.gamedeveloper.com/programming/the-entity-component-worker-architecture-and-its-use-on-massive-online-games)** — Distributes ECS entities across multiple servers. Used by Worlds Adrift (Bossa Studios).

<p align="center"><img src="https://raw.githubusercontent.com/RvRooijen/archetype-ecs-net/master/divider.svg" width="1000" /></p>

## API reference

### Shared

| Export | Description |
|---|---|
| `createComponentRegistry(registrations)` | Create a registry mapping components to wire IDs. Set `clientOwned: true` per component for client→server sync. Must be identical on server and client. |
| `Networked` | Tag component. Add to any entity that should be synced. |

### Server — `createNetServer(em, registry, config, transport?, options?)`

| Method / Property | Description |
|---|---|
| `start()` | Start listening on configured port |
| `stop()` | Stop server, disconnect all clients |
| `tick(filter?)` | Diff → encode → send. No filter = broadcast. With filter = per-client interest |
| `send(clientId, data)` | Send a custom message to a specific client |
| `clientCount` | Number of connected clients |
| `entityNetIds` | `ReadonlyMap<EntityId, number>` — entity → netId mapping |
| `onConnect` | Callback when a new client connects |
| `onReconnect` | Callback when a client resumes a session (same clientId) |
| `onDisconnect` | Callback when client disconnects (after grace period if reconnect enabled) |
| `onMessage` | Callback when client sends a custom message |
| `validate(component, handlers)` | Register per-component validation. Returns `server` for chaining. See below. |

**Config:**

| Option | Description |
|---|---|
| `port` | WebSocket listen port |
| `reconnectWindow` | Grace period in ms before `onDisconnect` fires. Default `30000`. Set to `0` to disable reconnect. |

**Options:**

| Option | Description |
|---|---|
| `ownerComponent` | `{ component, clientIdField }` — validates that client deltas only modify entities owned by the sender |

**Per-component validation** — `server.validate(component, handlers)`:

Register `delta`, `attach`, and/or `detach` handlers per component. Return `false` to reject.

```ts
server.validate(Position, {
  delta(clientId, entityId, data) {
    if (!isWalkable(data.x, data.y)) return false
    return true
  },
})

server.validate(Attacking, {
  attach(clientId, entityId, data) {
    // check adjacency, cooldowns, etc.
    return true
  },
  detach(clientId, entityId) {
    return true
  },
})
```

### Client — `createNetClient(em, registry, options?)`

| Method / Property | Description |
|---|---|
| `connect(url)` | Connect to server |
| `disconnect()` | Close connection |
| `tick()` | Diff client-owned components and send delta to server. Call once per frame. |
| `send(data)` | Send a binary message to the server |
| `connected` | Whether currently connected |
| `clientId` | Client ID assigned by the server on connect |
| `netToEntity` | `ReadonlyMap<number, EntityId>` — netId → local entity mapping |
| `ownedEntities` | `EntityId[]` — all entities owned by this client (requires `ownerComponent` option) |
| `onConnected` | Callback on first connection (new clientId) |
| `onReconnected` | Callback on session resume (same clientId) |
| `onDisconnected` | Callback on disconnect |
| `onMessage` | Callback for unrecognized (custom) messages |

**Options:**

| Option | Description |
|---|---|
| `ownerComponent` | `{ component, clientIdField }` — only diff and send entities where `clientIdField` matches this client's ID |

## License

MIT
