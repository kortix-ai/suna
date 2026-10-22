import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped memo. Inside `withRequestMemo`, `memoInRequest(key, load)`
 * runs `load` once and hands every later caller of the same key the same
 * promise, so a hot path can start a read early (prefetch) and the code that
 * needs it later reuses it. Nothing outlives the request: no cross-request
 * cache, no staleness, no invalidation. Outside a memo scope it is a plain call.
 */
const store = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export function withRequestMemo<T>(fn: () => Promise<T>): Promise<T> {
  return store.run(new Map(), fn);
}

export function memoInRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = store.getStore();
  if (!memo) return load();
  const hit = memo.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const pending = load();
  memo.set(key, pending);
  // A rejected prefetch nobody awaited yet must not surface as unhandled.
  pending.catch(() => {});
  return pending;
}
