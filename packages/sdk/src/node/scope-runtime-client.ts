/**
 * Per-request config scoping for the `.runtime` / `runtime()` escape hatch.
 *
 * `createScopedKortix` (see `./server.ts`) wraps every facade method so it runs
 * inside `runScoped(config, …)` — each incoming request's config is isolated on
 * an `AsyncLocalStorage` context. That generic wrapper recurses into plain
 * objects/functions but DELIBERATELY passes class instances through untouched,
 * so it never mis-clones a vendor object whose correctness depends on its
 * prototype/internal slots (`Response`, `Blob`, `Map`, …).
 *
 * The raw opencode `OpencodeClient` returned by `session.runtime` (and the
 * top-level `runtime()`) is exactly such a class instance — so the generic
 * wrapper leaves it alone. But its methods authenticate through
 * `authenticatedFetch`, which reads the AMBIENT platform config at call time. A
 * caller holds the returned client and invokes its methods OUTSIDE any
 * `runScoped` frame, so without help those calls resolve the process-global
 * config — the wrong tenant in a multi-tenant server (config bleed), or an
 * unconfigured 401 in a pure-scoped one (`createScopedKortix` never writes the
 * global). This module bridges that gap: it wraps the branded client in a Proxy
 * that re-enters `runScoped(config, …)` around every method call, so the fetch
 * always sees THIS request's config regardless of the caller's ambient frame.
 *
 * Scope of the fix: request/response methods (`runtime.session.prompt`,
 * `runtime.file.read`, `runtime.app.get`, …) are fully covered. A method's
 * RETURN VALUE is left untouched — it is plain data, not a further call. The one
 * known gap is a lazily-connecting async iterable returned by the raw client
 * (e.g. a hand-rolled `runtime.event.subscribe()` whose network I/O happens only
 * once the caller starts iterating, after the wrapped call has returned); for
 * scoped event streaming use the SDK's first-class `session.stream()`, which is
 * already correctly scoped.
 */
import type { KortixPlatformConfig } from '../core/http/config';
import { runScoped } from '../platform/config-node';

/**
 * Recursively wrap a branded opencode runtime client so every method call runs
 * inside `runScoped(config, …)`. Nested namespaces (`client.session`,
 * `client.file`, …) are proxied on access; the `cache` (one per top-level call)
 * preserves referential identity so repeated access to the same namespace yields
 * the same proxy. Methods are invoked with the REAL target as their receiver, so
 * the client's own `this`-binding is preserved.
 */
export function scopeRuntimeClient<T extends object>(
  client: T,
  config: KortixPlatformConfig,
  cache: WeakMap<object, object> = new WeakMap(),
): T {
  const cached = cache.get(client);
  if (cached) return cached as T;

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => runScoped(config, () => fn.apply(target, args));
      }
      // Recurse into the client's own namespace objects (session, file, …) so
      // `client.session.prompt(…)` is scoped too. Return values are NOT proxied
      // — they are plain data the caller consumes, not further scoped calls.
      if (value !== null && typeof value === 'object') {
        return scopeRuntimeClient(value as object, config, cache);
      }
      return value;
    },
  });

  cache.set(client, proxy);
  return proxy as T;
}
