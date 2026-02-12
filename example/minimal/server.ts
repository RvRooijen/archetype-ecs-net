import { createEntityManager } from 'archetype-ecs';
import { createNetServer, Networked } from '../../src/index.js';
import { Position, Color, registry, PORT, TICK_MS, ENTITY_COUNT, WORLD_SIZE } from './shared.js';

const em = createEntityManager();

// Spawn entities in a ring with random colors
for (let i = 0; i < ENTITY_COUNT; i++) {
  const angle = (i / ENTITY_COUNT) * Math.PI * 2;
  em.createEntityWith(
    Position, { x: WORLD_SIZE / 2 + Math.cos(angle) * 120, y: WORLD_SIZE / 2 + Math.sin(angle) * 120 },
    Color,    { r: 40 + (Math.random() * 200 | 0), g: 40 + (Math.random() * 200 | 0), b: 40 + (Math.random() * 200 | 0) },
    Networked,
  );
}

const server = createNetServer(em, registry, { port: PORT });
await server.start();
console.log(`Minimal server on ws://localhost:${PORT} (${TICK_MS}ms tick, ${ENTITY_COUNT} entities)`);

// Game loop — orbit entities around center
let tick = 0;
setInterval(() => {
  const t = tick++ * 0.03;
  let i = 0;
  em.forEach([Position], (a) => {
    const px = a.field(Position.x) as Float32Array;
    const py = a.field(Position.y) as Float32Array;
    for (let j = 0; j < a.count; j++) {
      const angle = ((i + j) / ENTITY_COUNT) * Math.PI * 2 + t;
      const r = 100 + Math.sin(t * 0.5 + i + j) * 40;
      px[j] = WORLD_SIZE / 2 + Math.cos(angle) * r;
      py[j] = WORLD_SIZE / 2 + Math.sin(angle) * r;
    }
    i += a.count;
  });
  server.tick();
}, TICK_MS);
