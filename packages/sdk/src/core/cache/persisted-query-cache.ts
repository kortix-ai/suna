/**
 * A query cache that survives a reload or an app restart.
 *
 * Without it, every surface starts from nothing after a reload: the project
 * gate, the session list and the account switcher each wait on the network,
 * so a slow backend shows a loading screen where the user's sessions were a
 * second earlier. With it, the last known answer renders in the first frame
 * and the query refetches it in place: a restored entry keeps its original
 * `dataUpdatedAt`, and it is marked invalidated, so even one younger than its
 * `staleTime` refetches the first time something reads it.
 *
 * Framework-free: it reads a TanStack `QueryClient` through the structural
 * {@link PersistableQueryClient} slice and never imports TanStack, so web and
 * React Native share it. The host passes the storage (`localStorage` on web,
 * AsyncStorage on mobile) and the signed-in user.
 *
 * What it will not do:
 *  - restore another user's cache (the key and the payload both name the user);
 *  - overwrite data already in memory that is as new or newer;
 *  - keep a query the predicate rejects, or one that never had data;
 *  - throw: a full, corrupt or missing store costs only the old cold start.
 */

/** A string key-value store. Synchronous stores restore synchronously. */
export interface KeyValueStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** One query, as much of it as persistence reads. */
export interface PersistableQuery {
  queryKey: readonly unknown[];
  state: { data: unknown; dataUpdatedAt: number };
}

/** The slice of a TanStack `QueryClient` this module uses. */
export interface PersistableQueryClient {
  getQueryCache(): {
    getAll(): readonly PersistableQuery[];
    subscribe(listener: (event: { type: string; query: PersistableQuery }) => void): () => void;
  };
  getQueryState(queryKey: readonly unknown[]): { data?: unknown; dataUpdatedAt: number } | undefined;
  setQueryData(queryKey: readonly unknown[], data: unknown, options?: { updatedAt?: number }): unknown;
  /**
   * Marks a restored entry so it refetches the first time it is read. Optional
   * in the type only: a TanStack `QueryClient` has it.
   */
  invalidateQueries?(filters: {
    queryKey: readonly unknown[];
    exact?: boolean;
    refetchType?: 'none';
  }): unknown;
}

export interface PersistedQueryCacheOptions {
  storage: KeyValueStorage;
  /** The signed-in user. Only this user's cache is read or written. */
  userId: string;
  /** Which queries to keep. {@link isPersistableQueryKey} covers the SDK's keys. */
  shouldPersist: (queryKey: readonly unknown[]) => boolean;
  /** Change it to discard every stored cache, for example after a data shape change. */
  version?: string;
  /** Entries older than this are not restored. Default: 7 days. */
  maxAgeMs?: number;
  /** Upper bound of the stored payload, in UTF-16 code units. Default: 1,000,000. */
  maxBytes?: number;
  /** Writes are coalesced over this interval, in ms. Default: 1,000. */
  throttleMs?: number;
  /** Storage key prefix. Default: `kortix.query-cache`. */
  namespace?: string;
  now?: () => number;
}

export interface PersistedQueryCache {
  /** The storage key of this user's cache. */
  readonly storageKey: string;
  /**
   * Put the stored queries into `client`. Returns how many were restored:
   * synchronously when the storage is synchronous, else as a promise.
   */
  restore(client: PersistableQueryClient): number | Promise<number>;
  /** Keep the store in step with `client`. Returns the unsubscribe function. */
  persist(client: PersistableQueryClient): () => void;
  /** Write now, if a kept query changed since the last write. */
  flush(): Promise<void>;
  /** Forget this user's stored cache. */
  clear(): Promise<void>;
}

/** Bump when a persisted query's data shape changes incompatibly. */
export const PERSISTED_QUERY_CACHE_VERSION = '1';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_THROTTLE_MS = 1_000;
const DEFAULT_NAMESPACE = 'kortix.query-cache';

interface StoredEntry {
  /** Query key. */
  k: readonly unknown[];
  /** Data. */
  d: unknown;
  /** `dataUpdatedAt`. */
  t: number;
}

interface StoredCache {
  v: string;
  user: string;
  at: number;
  queries: StoredEntry[];
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function settle(value: void | Promise<void>): Promise<void> {
  return isPromise<void>(value) ? value : Promise.resolve();
}

/**
 * The SDK query keys that are safe and useful to keep across a reload: the
 * inventory a user navigates by. Everything else — transcripts, turns, prompts,
 * secrets, files, config — is either live, large, or sensitive.
 */
export function isPersistableQueryKey(queryKey: readonly unknown[]): boolean {
  if (queryKey[0] !== 'kx') return false;
  const family = queryKey[1];
  if (family === 'accounts') {
    return queryKey.length === 3 && typeof queryKey[2] === 'string' && queryKey[2] !== 'anonymous';
  }
  if (family === 'projects') return queryKey.length === 3;
  if (family !== 'project' || typeof queryKey[2] !== 'string') return false;
  const segment = queryKey[3];
  if (queryKey.length === 4) return segment === 'summary' || segment === 'detail';
  if (segment !== 'sessions') return false;
  if (queryKey.length === 6) return queryKey[4] === 'list-paged';
  // `qk.project.session(id, sessionId)`: the session row. Its siblings under
  // `sessionsScope` are the list families and the per-session children.
  return queryKey.length === 5 && queryKey[4] !== 'list' && queryKey[4] !== 'list-paged';
}

export function createPersistedQueryCache(options: PersistedQueryCacheOptions): PersistedQueryCache {
  const {
    storage,
    userId,
    shouldPersist,
    version = PERSISTED_QUERY_CACHE_VERSION,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    throttleMs = DEFAULT_THROTTLE_MS,
    namespace = DEFAULT_NAMESPACE,
    now = () => Date.now(),
  } = options;
  const storageKey = `${namespace}:${userId}`;

  let attached: PersistableQueryClient | null = null;
  /** A kept query changed since the last write (or the client was just attached). */
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const forget = (): Promise<void> => {
    try {
      return settle(storage.removeItem(storageKey)).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  };

  const apply = (client: PersistableQueryClient, raw: string | null): number => {
    if (!raw) return 0;
    let stored: StoredCache;
    try {
      stored = JSON.parse(raw) as StoredCache;
    } catch {
      void forget();
      return 0;
    }
    if (
      !stored ||
      stored.v !== version ||
      stored.user !== userId ||
      !Array.isArray(stored.queries) ||
      now() - stored.at > maxAgeMs
    ) {
      void forget();
      return 0;
    }
    let restored = 0;
    for (const entry of stored.queries) {
      if (!entry || !Array.isArray(entry.k) || entry.d === undefined) continue;
      if (typeof entry.t !== 'number' || now() - entry.t > maxAgeMs) continue;
      if (!shouldPersist(entry.k)) continue;
      const current = client.getQueryState(entry.k);
      if (current && current.data !== undefined && current.dataUpdatedAt >= entry.t) continue;
      client.setQueryData(entry.k, entry.d, { updatedAt: entry.t });
      // Its age alone does not make it stale: a gate cached for 5 minutes and
      // restored 1 minute later would never refetch.
      void client.invalidateQueries?.({ queryKey: entry.k, exact: true, refetchType: 'none' });
      restored += 1;
    }
    return restored;
  };

  const snapshot = (client: PersistableQueryClient): StoredEntry[] =>
    client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.data !== undefined && shouldPersist(query.queryKey))
      .map((query) => ({ k: query.queryKey, d: query.state.data, t: query.state.dataUpdatedAt }))
      .sort((a, b) => b.t - a.t);

  /** Newest first, up to `budget` code units of serialized entries. */
  const fit = (entries: StoredEntry[], budget: number): StoredEntry[] => {
    const kept: StoredEntry[] = [];
    let used = 0;
    for (const entry of entries) {
      const size = JSON.stringify(entry).length + 1;
      if (used + size > budget) continue;
      kept.push(entry);
      used += size;
    }
    return kept;
  };

  const write = async (client: PersistableQueryClient): Promise<void> => {
    let entries = fit(snapshot(client), maxBytes);
    // A full store refuses the write. Halve the payload, newest kept, until it
    // fits or nothing is left to keep.
    while (true) {
      const payload: StoredCache = { v: version, user: userId, at: now(), queries: entries };
      try {
        await settle(storage.setItem(storageKey, JSON.stringify(payload)));
        return;
      } catch {
        if (entries.length === 0) return;
        entries = entries.slice(0, Math.floor(entries.length / 2));
      }
    }
  };

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /** Writes are chained, so two never interleave on an async store. */
  const writeNow = (): Promise<void> => {
    cancelTimer();
    const client = attached;
    // Nothing changed since the last write: a flush on every tab switch must
    // not re-serialize the whole cache.
    if (!client || !dirty) return writing;
    dirty = false;
    writing = writing.then(() => write(client)).catch(() => undefined);
    return writing;
  };

  const schedule = () => {
    dirty = true;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, throttleMs);
  };

  return {
    storageKey,

    restore(client) {
      let raw: string | null | Promise<string | null>;
      try {
        raw = storage.getItem(storageKey);
      } catch {
        return 0;
      }
      if (isPromise<string | null>(raw)) {
        return raw.then((value) => apply(client, value)).catch(() => 0);
      }
      return apply(client, raw);
    },

    persist(client) {
      attached = client;
      // The first flush writes what the client holds now.
      dirty = true;
      const unsubscribe = client.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' && event.type !== 'removed' && event.type !== 'added') return;
        if (!shouldPersist(event.query.queryKey)) return;
        schedule();
      });
      return () => {
        unsubscribe();
        if (attached !== client) return;
        attached = null;
        cancelTimer();
      };
    },

    /** Write now, if a kept query changed since the last write. */
    flush() {
      return writeNow();
    },

    async clear() {
      cancelTimer();
      attached = null;
      dirty = false;
      await writing;
      await forget();
    },
  };
}

/**
 * The browser's `localStorage` as a {@link KeyValueStorage}, or `null` where
 * there is none (server render, React Native, a sandboxed frame). Every call
 * is guarded: Safari's private mode and a full quota throw on access.
 */
export function browserKeyValueStorage(): KeyValueStorage | null {
  interface SyncStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  }
  let found: SyncStore | undefined;
  try {
    // Reading the property itself throws where storage is blocked.
    found = (globalThis as { localStorage?: SyncStore }).localStorage;
  } catch {
    found = undefined;
  }
  if (!found) return null;
  const local: SyncStore = found;
  return {
    getItem: (key) => {
      try {
        return local.getItem(key);
      } catch {
        return null;
      }
    },
    // Throws on a full quota on purpose: the writer halves its payload and retries.
    setItem: (key, value) => local.setItem(key, value),
    removeItem: (key) => {
      try {
        local.removeItem(key);
      } catch {
        // Nothing to forget.
      }
    },
  };
}
