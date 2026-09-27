/**
 * query-cache-binder — keeps the persisted query cache (the SDK's
 * `createPersistedQueryCache`) bound to the signed-in user.
 *
 * - `bind(client, userId)` restores this user's stored queries into the
 *   client, then keeps the store in step with it. One restore per user: the
 *   start screen (app/index.tsx) and the root layout both call it and share
 *   the promise.
 * - A bind for another user, or for none (signed out), first stops the writes
 *   and forgets the previous user's store. When the client still holds another
 *   user's queries in memory, they are cleared before the restore: they are
 *   never shown to this user, and never stored under this user's key.
 * - `release()` is sign-out: it stops the writes and forgets the store BEFORE
 *   the caller clears the client. Otherwise the clear's removals schedule one
 *   more write, of an empty cache, under the old user's key.
 * - `flush()` writes a pending change now: the app is going to the background,
 *   where the system may end it before the write timer fires.
 *
 * Framework-free and injectable: tests pass a memory store and a real client.
 */

import {
  createPersistedQueryCache,
  type KeyValueStorage,
  type PersistableQueryClient,
  type PersistedQueryCache,
} from '@kortix/sdk';

/** The query client slice the binder uses: the SDK's, plus `clear`. */
export interface BindableQueryClient extends PersistableQueryClient {
  clear(): void;
}

export interface QueryCacheBinderOptions {
  storage: KeyValueStorage;
  shouldPersist: (queryKey: readonly unknown[]) => boolean;
  /** Runs once the stored queries are in the client, before the writes start. */
  afterRestore?: (client: BindableQueryClient) => void;
  version?: string;
  maxBytes?: number;
  throttleMs?: number;
  now?: () => number;
}

export interface QueryCacheBinder {
  /** Restore and keep `userId`'s cache; `null` releases the bound user. */
  bind(client: BindableQueryClient, userId: string | null): Promise<void>;
  /** Stop writing and forget the bound user's store. */
  release(): Promise<void>;
  /** Write a pending change now. */
  flush(): Promise<void>;
  /** The bound user, or null. */
  readonly userId: string | null;
}

interface Binding {
  userId: string;
  client: BindableQueryClient;
  cache: PersistedQueryCache;
  /** Ends the writes. A no-op until the restore has finished. */
  stop: () => void;
  ready: Promise<void>;
}

export function createQueryCacheBinder(options: QueryCacheBinderOptions): QueryCacheBinder {
  const { storage, shouldPersist, afterRestore, version, maxBytes, throttleMs, now } = options;
  let bound: Binding | null = null;
  // The user whose queries the client holds in memory. Not reset by
  // `release()`: every sign-out clears the client itself.
  let memoryOwner: string | null = null;

  const unbind = (): Promise<void> => {
    const previous = bound;
    bound = null;
    if (!previous) return Promise.resolve();
    previous.stop();
    return previous.cache.clear();
  };

  return {
    get userId() {
      return bound?.userId ?? null;
    },

    bind(client, userId) {
      if (bound && bound.userId === userId) {
        if (bound.client === client) return bound.ready;
        // The same user on another client (the root layout remounted, as a
        // Fast Refresh can): move the writes to it and keep the store.
        bound.stop();
        bound = null;
      }
      const released = unbind();
      if (!userId) return released;

      if (memoryOwner !== null && memoryOwner !== userId) client.clear();
      memoryOwner = userId;

      // An option left undefined takes the SDK's default.
      const cache = createPersistedQueryCache({
        storage,
        userId,
        shouldPersist,
        version,
        maxBytes,
        throttleMs,
        now,
      });
      const binding: Binding = {
        userId,
        client,
        cache,
        stop: () => {},
        ready: Promise.resolve(),
      };
      binding.ready = released
        .then(() => cache.restore(client))
        .then(() => {
          // Released or replaced while the store was read: never attach.
          if (bound !== binding) return;
          afterRestore?.(client);
          // Attached after the restore, so the first write holds the restored
          // queries instead of replacing the store with an empty cache.
          binding.stop = cache.persist(client);
        })
        // The SDK's restore never throws; a failure costs the old cold start.
        .catch(() => undefined);
      bound = binding;
      return binding.ready;
    },

    release: unbind,

    flush() {
      return bound ? bound.cache.flush() : Promise.resolve();
    },
  };
}
