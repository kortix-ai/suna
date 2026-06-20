/**
 * Tiny async TTL memoizer with in-flight de-duplication.
 *
 * Built for the request-path authorization lookups (actor resolve, account
 * membership, project roles): the frontend fires 10+ parallel requests per
 * page that each repeat the exact same principal queries, and prod pays a
 * cross-region roundtrip (~150ms) for every one of them. Collapsing the
 * burst to one lookup per (key, TTL window) removes most of that cost.
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
 */

type Entry<T> = { value: Promise<T>; expiresAt: number };

export type TtlMemo<A extends unknown[], T> = ((...args: A) => Promise<T>) & {
  /** Drop all cached entries (tests / targeted invalidation). */
  clear: () => void;
};

export function ttlMemo<A extends unknown[], T>(opts: {
  ttlMs: number;
  keyFn: (...args: A) => string;
  loader: (...args: A) => Promise<T>;
  /** Return false to skip caching this resolved value. Default: cache all. */
  shouldCache?: (value: T) => boolean;
  /** Hard cap on entries; oldest-inserted are evicted past it. Default 10k. */
  maxEntries?: number;
  /** Caching is bypassed under `bun test` (NODE_ENV=test) so unit tests
   *  never bleed state across cases; the memo's own tests set this. */
  enableInTests?: boolean;
}): TtlMemo<A, T> {
  const { ttlMs, keyFn, loader, shouldCache } = opts;
  const maxEntries = opts.maxEntries ?? 10_000;
  const cache = new Map<string, Entry<T>>();

  const disabled =
    ttlMs <= 0 || (process.env.NODE_ENV === 'test' && !opts.enableInTests);

  const fn = (async (...args: A): Promise<T> => {
    if (disabled) return loader(...args);

    const key = keyFn(...args);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    if (hit) cache.delete(key);

    const value = loader(...args).then(
      (resolved) => {
        if (shouldCache && !shouldCache(resolved)) cache.delete(key);
        return resolved;
      },
      (err) => {
        cache.delete(key);
        throw err;
      },
    );

    cache.set(key, { value, expiresAt: now + ttlMs });

    // Bounded memory: evict oldest-inserted entries past the cap. Map
    // preserves insertion order, so the first keys are the oldest.
    if (cache.size > maxEntries) {
      const excess = cache.size - maxEntries;
      let i = 0;
      for (const k of cache.keys()) {
        cache.delete(k);
        if (++i >= excess) break;
      }
    }

    return value;
  }) as TtlMemo<A, T>;

  fn.clear = () => cache.clear();
  return fn;
}
