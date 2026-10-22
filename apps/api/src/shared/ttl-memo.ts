/**
 * Tiny async TTL memoizer with in-flight de-duplication.
 *
 * Built for the request-path authorization lookups (actor resolve, account
 * membership, project roles): the frontend fires 10+ parallel requests per
 * page that each repeat the exact same principal queries. Each is a fast,
 * same-region indexed lookup (~3ms measured, DB and API both in eu-west-2 —
 * not the cross-region roundtrip this comment used to claim), but they still
 * add up across a burst of duplicate queries. Collapsing the burst to one
 * lookup per (key, TTL window) removes most of that redundant query volume.
 *
 * Semantics:
 *  - Concurrent callers with the same key share one in-flight promise.
 *  - Rejections are never cached — the entry is dropped so the next caller
 *    retries.
 *  - `shouldCache` lets callers skip caching specific values. The auth
 *    wrappers use it to never cache *negative* results (null membership /
 *    no role): a just-granted member must see access immediately, while a
 *    just-revoked one keeping access for one TTL window is acceptable.
 *  - TTL <= 0 disables caching entirely (loader called every time), and
 *    `bun test` (NODE_ENV=test) always bypasses so unit tests never bleed
 *    state across cases.
 *  - `staleWhileRevalidate` serves the last resolved value the instant it is
 *    asked for and refreshes behind the response, so a loader slower than the
 *    TTL never lands on the caller's critical path after the first call. For a
 *    polling read whose tail IS the loader's tail (a live provider round trip),
 *    this is the difference between p95 tracking the provider and p95 being a
 *    cached read.
 */

type Entry<T> = {
  value: Promise<T>;
  expiresAt: number;
  /** The initial load settled (resolved). A still-pending value is shared. */
  settled: boolean;
  /** A stale-while-revalidate refresh is in flight. */
  refreshing?: boolean;
};

export type TtlMemo<A extends unknown[], T> = ((...args: A) => Promise<T>) & {
  /** Drop all cached entries (tests / targeted invalidation). */
  clear: () => void;
  /** Drop a single entry by its exact key. No-op if absent. */
  invalidate: (key: string) => void;
  /** Drop every entry whose key starts with `prefix`. Used to bust all of a
   *  principal's entries on a grant/revoke (keys are `${userId}|…`). */
  invalidateByPrefix: (prefix: string) => void;
};

export function ttlMemo<A extends unknown[], T>(opts: {
  ttlMs: number;
  keyFn: (...args: A) => string;
  loader: (...args: A) => Promise<T>;
  /** Return false to skip caching this resolved value. Receives the loader
   *  args too, so a memo can decide per key (e.g. "never cache an empty
   *  result for this resource type"). Default: cache all. */
  shouldCache?: (value: T, ...args: A) => boolean;
  /** Hard cap on entries; oldest-inserted are evicted past it. Default 10k. */
  maxEntries?: number;
  /** Serve an expired-but-resolved value immediately and refresh it behind the
   *  response, instead of blocking the caller on a reload. Only the first call
   *  per key ever waits on the loader; if a refresh fails the last good value
   *  keeps serving and the next call retries. Default: false (blocking reload,
   *  the original behavior). */
  staleWhileRevalidate?: boolean;
  /** Caching is bypassed under `bun test` (NODE_ENV=test) so unit tests
   *  never bleed state across cases; the memo's own tests set this. */
  enableInTests?: boolean;
}): TtlMemo<A, T> {
  const { ttlMs, keyFn, loader, shouldCache } = opts;
  const staleWhileRevalidate = opts.staleWhileRevalidate ?? false;
  const maxEntries = opts.maxEntries ?? 10_000;
  const cache = new Map<string, Entry<T>>();

  const disabled = ttlMs <= 0 || (process.env.NODE_ENV === 'test' && !opts.enableInTests);

  const evictPastCap = () => {
    // Bounded memory: evict oldest-inserted entries past the cap. Map
    // preserves insertion order, so the first keys are the oldest.
    if (cache.size <= maxEntries) return;
    const excess = cache.size - maxEntries;
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++i >= excess) break;
    }
  };

  const startLoad = (key: string, args: A): Promise<T> => {
    const entry: Entry<T> = {
      value: undefined as unknown as Promise<T>,
      expiresAt: Date.now() + ttlMs,
      settled: false,
    };
    entry.value = loader(...args).then(
      (resolved) => {
        entry.settled = true;
        if (shouldCache && !shouldCache(resolved, ...args)) cache.delete(key);
        return resolved;
      },
      (err) => {
        cache.delete(key);
        throw err;
      },
    );
    cache.set(key, entry);
    evictPastCap();
    return entry.value;
  };

  const refresh = (entry: Entry<T>, key: string, args: A) => {
    entry.refreshing = true;
    // Fire-and-forget: the caller already has the last good value. Freshness
    // restarts at SETTLE, not start, so a refresh slower than the TTL does not
    // leave the entry expired when the fresh value lands. A failure keeps the
    // last good value; the next expired call retries.
    void loader(...args).then(
      (resolved) => {
        entry.refreshing = false;
        entry.expiresAt = Date.now() + ttlMs;
        if (shouldCache && !shouldCache(resolved, ...args)) {
          cache.delete(key);
          return;
        }
        entry.value = Promise.resolve(resolved);
        entry.settled = true;
      },
      () => {
        entry.refreshing = false;
        entry.expiresAt = 0;
      },
    );
  };

  const fn = (async (...args: A): Promise<T> => {
    if (disabled) return loader(...args);

    const key = keyFn(...args);
    const hit = cache.get(key);
    if (hit) {
      // Fresh within the TTL, or a load is still in flight: share it.
      if (hit.expiresAt > Date.now() || !hit.settled) return hit.value;
      if (staleWhileRevalidate) {
        if (!hit.refreshing) refresh(hit, key, args);
        return hit.value;
      }
      cache.delete(key);
    }

    return startLoad(key, args);
  }) as TtlMemo<A, T>;

  fn.clear = () => cache.clear();
  fn.invalidate = (key: string) => {
    cache.delete(key);
  };
  fn.invalidateByPrefix = (prefix: string) => {
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  };
  return fn;
}

/**
 * Insert-or-refresh `key` in `map` and evict the oldest-inserted entries past
 * `max`. Map preserves insertion order, so the first key is the oldest.
 */
export function bumpBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}
