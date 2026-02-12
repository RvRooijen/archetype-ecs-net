import { createEntityManager } from 'archetype-ecs';
import type { EntityId } from 'archetype-ecs';
// Use 'archetype-ecs-net' when outside this repo
import { Networked } from '../../src/index.js';
import { Position, EntityType, Health, Appearance } from '../shared.js';
import { ChunkManager } from './chunks.js';
import { CHUNK_SIZE } from '../shared.js';

export const em = createEntityManager();
export const chunks = new ChunkManager(CHUNK_SIZE);

export function spawnEntity(x: number, y: number, kind: number, hp: number, variant: number): EntityId {
  const eid = em.createEntityWith(
    Position, { x, y },
    EntityType, { kind },
    Health, { current: hp, max: hp },
    Appearance, { variant },
    Networked,
  );
  chunks.add(eid, x, y);
  return eid;
}

export function destroyEntity(eid: EntityId) {
  const x = em.get(eid, Position.x) as number;
  const y = em.get(eid, Position.y) as number;
  chunks.remove(eid, x, y);
  em.destroyEntity(eid);
}

export function entityAt(tx: number, ty: number, kind?: number): EntityId | undefined {
  const set = chunks.atTile(tx, ty);
  if (!set) return undefined;
  for (const eid of set) {
    if (em.get(eid, Position.x) === tx && em.get(eid, Position.y) === ty) {
      if (kind === undefined || em.get(eid, EntityType.kind) === kind) return eid;
    }
  }
  return undefined;
}
