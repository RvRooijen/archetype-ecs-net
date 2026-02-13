import type { EntityId } from 'archetype-ecs';

export class ChunkManager {
  private readonly shift: number;
  private readonly chunks = new Map<number, Set<EntityId>>();

  constructor(chunkSize: number) {
    this.shift = Math.log2(chunkSize);
  }

  private key(tx: number, ty: number): number {
    return (tx >> this.shift) | ((ty >> this.shift) << 8);
  }

  add(eid: EntityId, tx: number, ty: number) {
    const k = this.key(tx, ty);
    let set = this.chunks.get(k);
    if (!set) { set = new Set(); this.chunks.set(k, set); }
    set.add(eid);
  }

  remove(eid: EntityId, tx: number, ty: number) {
    this.chunks.get(this.key(tx, ty))?.delete(eid);
  }

  move(eid: EntityId, ox: number, oy: number, nx: number, ny: number) {
    const ok = this.key(ox, oy), nk = this.key(nx, ny);
    if (ok === nk) return;
    this.chunks.get(ok)?.delete(eid);
    let set = this.chunks.get(nk);
    if (!set) { set = new Set(); this.chunks.set(nk, set); }
    set.add(eid);
  }

  /** Returns entity IDs from all chunks overlapping the given range */
  queryRange(cx: number, cy: number, range: number, worldSize: number): Set<EntityId>[] {
    const cxMin = Math.max(0, (cx - range) >> this.shift);
    const cxMax = Math.min((worldSize - 1) >> this.shift, (cx + range) >> this.shift);
    const cyMin = Math.max(0, (cy - range) >> this.shift);
    const cyMax = Math.min((worldSize - 1) >> this.shift, (cy + range) >> this.shift);

    const sets: Set<EntityId>[] = [];
    for (let chy = cyMin; chy <= cyMax; chy++) {
      for (let chx = cxMin; chx <= cxMax; chx++) {
        const set = this.chunks.get(chx | (chy << 8));
        if (set) sets.push(set);
      }
    }
    return sets;
  }

  /** Returns entities at a specific tile */
  atTile(tx: number, ty: number): Set<EntityId> | undefined {
    return this.chunks.get(this.key(tx, ty));
  }
}
