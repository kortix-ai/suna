/**
 * The payload layer of the persisted query cache: (de)serialization and the
 * storage budget, as pure functions over an explicit config. Split out of
 * `createPersistedQueryCache` (which keeps the write-coalescing state machine:
 * attached/dirty/timer/writing) so the storage format is unit-testable
 * without a QueryClient.
 *
 * Framework-free; internal to the module pair — nothing here is re-exported
 * from the package entry.
 */
import type { KeyValueStorage, PersistableQueryClient } from './persisted-query-cache';

export interface StoredEntry {
  /** Query key. */
  k: readonly unknown[];
  /** Data. */
  d: unknown;
  /** `dataUpdatedAt`. */
  t: number;
}

export interface StoredCache {
  v: string;
  user: string;
  at: number;
  queries: StoredEntry[];
}

export function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

export function settle(value: void | Promise<void>): Promise<void> {
  return isPromise<void>(value) ? value : Promise.resolve();
}

/** Everything the payload functions read, straight from the factory's options. */
export interface PayloadConfig {
  storage: KeyValueStorage;
  storageKey: string;
  version: string;
  userId: string;
  maxAgeMs: number;
  maxBytes: number;
  shouldPersist: (queryKey: readonly unknown[]) => boolean;
  now: () => number;
}

export function forget(config: PayloadConfig): Promise<void> {
  try {
    return settle(config.storage.removeItem(config.storageKey)).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

export function apply(
  config: PayloadConfig,
  client: PersistableQueryClient,
  raw: string | null,
): number {
  if (!raw) return 0;
  let stored: StoredCache;
  try {
    stored = JSON.parse(raw) as StoredCache;
  } catch {
    void forget(config);
    return 0;
  }
  if (
    !stored ||
    stored.v !== config.version ||
    stored.user !== config.userId ||
    !Array.isArray(stored.queries) ||
    config.now() - stored.at > config.maxAgeMs
  ) {
    void forget(config);
    return 0;
  }
  let restored = 0;
  for (const entry of stored.queries) {
    if (!entry || !Array.isArray(entry.k) || entry.d === undefined) continue;
    if (typeof entry.t !== 'number' || config.now() - entry.t > config.maxAgeMs) continue;
    if (!config.shouldPersist(entry.k)) continue;
    const current = client.getQueryState(entry.k);
    if (current && current.data !== undefined && current.dataUpdatedAt >= entry.t) continue;
    client.setQueryData(entry.k, entry.d, { updatedAt: entry.t });
    // Its age alone does not make it stale: a gate cached for 5 minutes and
    // restored 1 minute later would never refetch.
    void client.invalidateQueries?.({ queryKey: entry.k, exact: true, refetchType: 'none' });
    restored += 1;
  }
  return restored;
}

export function snapshot(config: PayloadConfig, client: PersistableQueryClient): StoredEntry[] {
  return client
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.data !== undefined && config.shouldPersist(query.queryKey))
    .map((query) => ({ k: query.queryKey, d: query.state.data, t: query.state.dataUpdatedAt }))
    .sort((a, b) => b.t - a.t);
}

/** Newest first, up to `budget` code units of serialized entries. */
export function fit(entries: StoredEntry[], budget: number): StoredEntry[] {
  const kept: StoredEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (used + size > budget) continue;
    kept.push(entry);
    used += size;
  }
  return kept;
}

export async function write(config: PayloadConfig, client: PersistableQueryClient): Promise<void> {
  let entries = fit(snapshot(config, client), config.maxBytes);
  // A full store refuses the write. Halve the payload, newest kept, until it
  // fits or nothing is left to keep.
  while (true) {
    const payload: StoredCache = {
      v: config.version,
      user: config.userId,
      at: config.now(),
      queries: entries,
    };
    try {
      await settle(config.storage.setItem(config.storageKey, JSON.stringify(payload)));
      return;
    } catch {
      if (entries.length === 0) return;
      entries = entries.slice(0, Math.floor(entries.length / 2));
    }
  }
}
