import type { ClientId } from './types.js';
import type { Changeset } from './DirtyTracker.js';

/**
 * Per-client interest filter callback.
 * Return the set of netIds that should be visible to this client.
 */
export type InterestFilter = (clientId: ClientId) => ReadonlySet<number>;

/** Describes what changed for a specific client this tick */
export interface ClientDelta {
  /** NetIds to send as "created" (entered view or globally new + in view) */
  readonly enters: number[];
  /** NetIds to send as "destroyed" (left view or globally destroyed + was known) */
  readonly leaves: number[];
  /** NetIds to send field updates for (dirty + in view + already known) */
  readonly updates: number[];
}

export interface ClientView {
  /** The set of netIds this client currently knows about */
  readonly knownEntities: ReadonlySet<number>;
  /** Pre-populate known set (e.g., after sending filtered full state on connect) */
  initKnown(netIds: ReadonlySet<number>): void;
  /** Compute enter/leave/update delta for this tick */
  update(currentInterest: ReadonlySet<number>, changeset: Changeset): ClientDelta;
}

export function createClientView(): ClientView {
  const known = new Set<number>();

  // Reusable arrays to avoid GC pressure
  const enters: number[] = [];
  const leaves: number[] = [];
  const updates: number[] = [];

  return {
    get knownEntities(): ReadonlySet<number> {
      return known;
    },

    initKnown(netIds: ReadonlySet<number>) {
      known.clear();
      for (const id of netIds) known.add(id);
    },

    update(interest: ReadonlySet<number>, changeset: Changeset): ClientDelta {
      enters.length = 0;
      leaves.length = 0;
      updates.length = 0;

      const destroyedSet = changeset.destroyedSet;
      const createdSet = changeset.createdSet;

      // 1. Globally destroyed entities that this client knew about → leave
      for (const netId of changeset.destroyed) {
        if (known.has(netId)) {
          leaves.push(netId);
          known.delete(netId);
        }
      }

      // 2. Globally created entities that are in interest → enter
      for (const entry of changeset.created) {
        if (interest.has(entry.netId)) {
          enters.push(entry.netId);
          known.add(entry.netId);
        }
      }

      // 3. Interest transitions for existing entities
      //    - In known but NOT in interest → leave (entity left view)
      //    - In interest but NOT in known → enter (entity entered view)
      for (const netId of known) {
        if (!interest.has(netId) && !destroyedSet.has(netId)) {
          leaves.push(netId);
        }
      }
      // Remove leaves from known
      for (const netId of leaves) known.delete(netId);

      for (const netId of interest) {
        if (!known.has(netId) && !createdSet.has(netId) && !destroyedSet.has(netId)) {
          enters.push(netId);
          known.add(netId);
        }
      }

      // 4. Dirty entities that are in known (and not just entered) → update
      for (const entry of changeset.dirty) {
        if (known.has(entry.netId) && !createdSet.has(entry.netId)) {
          // Check it's not a fresh enter (enters already get full data)
          let isEnter = false;
          for (let i = 0; i < enters.length; i++) {
            if (enters[i] === entry.netId) { isEnter = true; break; }
          }
          if (!isEnter) updates.push(entry.netId);
        }
      }

      return { enters, leaves, updates };
    },
  };
}
