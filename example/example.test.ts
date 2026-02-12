import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from './server/chunks.js';
import { bfs } from './server/pathfinding.js';

describe('ChunkManager', () => {
  it('tracks entities across chunks and queries by range', () => {
    const cm = new ChunkManager(8); // 8-tile chunks

    // Place entities in different chunks
    cm.add(1 as any, 2, 2);   // chunk (0,0)
    cm.add(2 as any, 10, 10); // chunk (1,1)
    cm.add(3 as any, 50, 50); // chunk (6,6) — far away

    // Query range=12 around (5,5) should find entities 1 and 2, not 3
    const sets = cm.queryRange(5, 5, 12, 64);
    const found = new Set<number>();
    for (const s of sets) for (const eid of s) found.add(eid as any);

    assert.ok(found.has(1), 'should find entity in same chunk');
    assert.ok(found.has(2), 'should find entity in neighboring chunk');
    assert.ok(!found.has(3), 'should not find entity far away');

    // Move entity 1 to chunk (6,6)
    cm.move(1 as any, 2, 2, 50, 50);
    const setsAfter = cm.queryRange(5, 5, 12, 64);
    const foundAfter = new Set<number>();
    for (const s of setsAfter) for (const eid of s) foundAfter.add(eid as any);

    assert.ok(!foundAfter.has(1), 'moved entity should no longer be in range');

    // Remove entity 2
    cm.remove(2 as any, 10, 10);
    const setsRemoved = cm.queryRange(5, 5, 12, 64);
    const foundRemoved = new Set<number>();
    for (const s of setsRemoved) for (const eid of s) foundRemoved.add(eid as any);

    assert.ok(!foundRemoved.has(2), 'removed entity should not appear');
  });
});

describe('BFS pathfinding', () => {
  it('finds shortest path around obstacles', () => {
    // 8x8 grid, wall at column 3 (rows 0-5), gap at row 6
    const blocked = new Set<string>();
    for (let y = 0; y <= 5; y++) blocked.add(`3,${y}`);

    const walkable = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < 8 && y < 8 && !blocked.has(`${x},${y}`);

    // Path from (1,1) to (5,1) must go around the wall
    const path = bfs(1, 1, 5, 1, 8, walkable);

    assert.ok(path.length > 0, 'should find a path');
    // Path must end at target
    assert.deepEqual(path[path.length - 1], { x: 5, y: 1 });
    // Path should not cross the wall
    for (const p of path) {
      assert.ok(!blocked.has(`${p.x},${p.y}`), `path should not cross wall at ${p.x},${p.y}`);
    }
    // Going around the wall takes more than 4 steps (direct would be 4)
    assert.ok(path.length > 4, 'path should route around wall');

    // Same position returns empty
    assert.deepEqual(bfs(1, 1, 1, 1, 8, walkable), []);

    // Unreachable target returns empty
    const fullyBlocked = () => false;
    assert.deepEqual(bfs(0, 0, 7, 7, 8, fullyBlocked), []);
  });
});

describe('ChunkManager atTile', () => {
  it('returns entities at specific tile coordinates', () => {
    const cm = new ChunkManager(8);

    cm.add(10 as any, 4, 4);
    cm.add(20 as any, 4, 5);

    const set = cm.atTile(4, 4);
    assert.ok(set, 'should return a set for occupied chunk');
    // Both entities are in the same chunk — atTile returns the chunk set
    assert.ok(set.has(10 as any));
    assert.ok(set.has(20 as any));

    // Empty tile in unoccupied chunk
    assert.equal(cm.atTile(60, 60), undefined);
  });
});
