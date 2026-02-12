# RPG Demo

Tile-based multiplayer RPG with interest management. Players move on a 64x64 procedural world, chop trees, mine rocks, and see NPCs wander. Each client only receives entities within view range.

## Running

```bash
npm run build                      # build dist/ (needed for browser client imports)
npx tsx example/server/main.ts     # start server on ws://localhost:9001
```

Serve the project root with any static file server and open `example/client.html` in a browser.

## Architecture

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

## How it works

**Server** uses `createNetServer` from archetype-ecs-net. Entities are spawned with the `Networked` tag and automatically tracked. Each tick:

1. Process player inputs (pathfinding, interactions)
2. Move players along paths
3. Wander NPCs randomly
4. Respawn destroyed resources
5. `server.tick(filter)` — diffs ECS state, encodes binary deltas, sends per-client based on interest

The interest filter (`getInterest`) uses a spatial chunk query to find entities within `VIEW_RANGE` tiles of each player, returning their netIds.

**Client** receives a full state snapshot on connect, then binary deltas every tick. The protocol decoder applies creates, destroys, and field updates to a local entity map. The renderer draws visible tiles and entities at 60fps.

## Custom messages

Two application-level messages are sent alongside the protocol's full state and delta messages:

| Marker | Payload | When |
|--------|---------|------|
| `0xFE` MSG_TILE_MAP | `u8 size` + `size*size` tile bytes | On connect |
| `0xFD` MSG_PLAYER_ID | `u16 netId` (LE) | After first tick (netId assigned) |

## Controls

- **Click/tap** a tile to pathfind there
- **Right-click/long-press** a tree or rock for context menu (chop/mine)
