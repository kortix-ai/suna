/**
 * Installed-item status — the "is there an update?" check that makes the
 * marketplace feel like WordPress plugins. The lock records each installed
 * item's file targets + sha256 hashes; to detect drift we re-resolve the item
 * from its source, re-hash, and compare. This module is the PURE comparison —
 * the caller does the resolving/hashing (network) and feeds the result in.
 */

import type { RegistryLockEntry } from './schema';

export type InstalledItemStatus = 'up-to-date' | 'update-available' | 'orphaned';

export interface InstalledDiff {
  status: InstalledItemStatus;
  /** Targets whose content hash changed at the source. */
  changed: string[];
  /** Targets the source now ships that we don't have. */
  added: string[];
  /** Targets we have that the source no longer ships. */
  removed: string[];
}

export interface InstalledFile {
  target: string;
  hash: string;
}

/**
 * Compare a lock entry's recorded files against freshly-resolved files from the
 * item's current source. `fresh === null` ⇒ the source no longer resolves
 * (orphaned — e.g. the registry was removed or the item renamed). An item with
 * no files of its own (a bundle) is always up-to-date; its members are tracked
 * as their own lock entries.
 */
export function compareInstalled(
  locked: ReadonlyArray<InstalledFile>,
  fresh: ReadonlyArray<InstalledFile> | null,
): InstalledDiff {
  if (fresh === null) return { status: 'orphaned', changed: [], added: [], removed: [] };

  const lockedMap = new Map(locked.map((f) => [f.target, f.hash]));
  const freshMap = new Map(fresh.map((f) => [f.target, f.hash]));

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [target, hash] of freshMap) {
    if (!lockedMap.has(target)) added.push(target);
    else if (lockedMap.get(target) !== hash) changed.push(target);
  }
  for (const target of lockedMap.keys()) if (!freshMap.has(target)) removed.push(target);

  const status: InstalledItemStatus =
    changed.length + added.length + removed.length > 0 ? 'update-available' : 'up-to-date';
  return { status, changed, added, removed };
}

/** Convenience: compare straight from a lock entry. */
export function diffLockEntry(entry: RegistryLockEntry, fresh: ReadonlyArray<InstalledFile> | null): InstalledDiff {
  return compareInstalled(entry.files, fresh);
}
