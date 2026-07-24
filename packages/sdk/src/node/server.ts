/**
 * `@kortix/sdk/server` — Node/Bun-only request-scoped config isolation for
 * "Kortix as a Backend": a third-party server process that wraps Kortix on
 * behalf of multiple end users/tenants concurrently.
 *
 * NEVER import this subpath from a browser bundle. It statically imports
 * `config-node.ts`, which statically imports `node:async_hooks` — most
 * browser bundlers choke if that appears anywhere in their graph. The root
 * `@kortix/sdk` entry point and `@kortix/sdk/react` never import this file,
 * so a web host's bundle is unaffected either way; this subpath exists
 * specifically for the non-browser "backend" case.
 *
 * Why this exists: `configureKortix()`/`createKortix()` (the root `@kortix/sdk`
 * seam) store the platform config — crucially, the bearer token getter — in a
 * single process-wide module-global (see `platform/config.ts`). That's fine
 * for a host with exactly one config for its whole lifetime (a browser tab, a
 * CLI, a single-tenant server). It is UNSAFE for a server process handling
 * concurrent requests on behalf of different users: two in-flight requests
 * racing through `configureKortix()` with different tokens clobber each
 * other — whichever call landed last wins for every other in-flight request
 * (see the warning on `ServerTokenOptions` in
 * `platform/projects-client/shared.ts`).
 *
 * `runWithKortix`/`createScopedKortix` fix that using Node's
 * `AsyncLocalStorage`: the config passed to one call is visible ONLY inside
 * that call's async continuation (every `await` inside it), correctly
 * isolated from any other concurrent call in the same process.
 */
import { createKortix, type Kortix } from '../core/client/kortix';
import { OPENCODE_RUNTIME_CLIENT_BRAND } from '../core/runtime/client';
import { runScoped, runWithKortix, getScopedConfig } from '../platform/config-node';
import type { KortixPlatformConfig } from '../core/http/config';
import { scopeRuntimeClient } from './scope-runtime-client';

export { runWithKortix, getScopedConfig };

const MAX_WRAP_DEPTH = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively wrap every function (including function-valued getters)
 * reachable from `value` so calling it runs inside `runScoped(config, ...)`.
 * Also wraps a wrapped function's OWN return value (sync, or the resolved
 * value of a returned Promise) — this is what makes id-bound handles minted
 * AT CALL TIME (`kortix.project(id)`, `kortix.session(pid, sid)`) come back
 * fully scoped too, not just the static shape of `createKortix()`'s top-level
 * return.
 *
 * Recurses into plain objects/arrays only — class instances and built-ins
 * (`Error`/`Date`/`Map`/`Set`/`Blob`/`Response`/async iterables/…) pass
 * through untouched, so this never mis-clones a vendor object whose
 * correctness depends on its prototype/internal slots (e.g. the escape-hatch
 * `OpencodeClient` from `.runtime`, or a `Response`/Blob returned by a file
 * read). A depth cap + a per-branch `WeakSet` guards against accidental
 * cycles or pathologically deep payloads.
 */
function wrapScoped<T>(value: T, config: KortixPlatformConfig, seen: WeakSet<object>, depth = 0): T {
  if (depth > MAX_WRAP_DEPTH) return value;

  // The `.runtime` / `runtime()` escape hatch returns a raw opencode client — a
  // class instance the plain-object/function recursion below would (correctly,
  // for a vendor object) pass through untouched. But its methods authenticate
  // with the AMBIENT config at call time, and the caller invokes them outside
  // any scope. Scope the branded client's method calls to THIS config so the
  // escape hatch is as tenant-isolated as the first-class facade methods. See
  // `scope-runtime-client.ts`.
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<PropertyKey, unknown>)[OPENCODE_RUNTIME_CLIENT_BRAND]
  ) {
    return scopeRuntimeClient(value as object, config) as unknown as T;
  }

  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    const wrapped = (...args: unknown[]): unknown => {
      const result = runScoped(config, () => fn(...args));
      if (result instanceof Promise) {
        return result.then((resolved) => wrapScoped(resolved, config, new WeakSet(), 0));
      }
      return wrapScoped(result, config, new WeakSet(), 0);
    };
    return wrapped as unknown as T;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => wrapScoped(item, config, seen, depth + 1)) as unknown as T;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key)!;
      if (desc.get) {
        Object.defineProperty(out, key, {
          enumerable: true,
          // Run the getter itself inside the scope, not just its result: a getter
          // like `session.runtime` builds its client via `getClientForUrl`, whose
          // `isConfigured()` guard must see THIS request's config — a scoped-only
          // server never writes the process-global one, so an out-of-scope build
          // would throw "no auth token provider configured". The built (branded)
          // client is then scoped by `wrapScoped`'s branded-client branch above.
          get: () =>
            runScoped(config, () => wrapScoped(desc.get!.call(value), config, new WeakSet(), 0)),
        });
      } else {
        out[key] = wrapScoped(desc.value, config, seen, depth + 1);
      }
    }
    return out as T;
  }

  return value;
}

/**
 * Same shape as `createKortix(config)`, but every method call — including
 * calls reached through `.project(id)`/`.session(pid, sid)` handles minted at
 * call time — automatically runs inside `runWithKortix(config, ...)`. This
 * handle never writes to (or is affected by) the process-global config
 * singleton other `createKortix()`/`configureKortix()` callers in the same
 * process share. Safe to construct one per incoming request in a multi-tenant
 * server:
 *
 *   import { createScopedKortix } from '@kortix/sdk/server';
 *
 *   app.get('/projects', async (req, res) => {
 *     const kortix = createScopedKortix({ backendUrl, getToken: () => tokenFor(req) });
 *     res.json(await kortix.projects.list());
 *   });
 *
 * Two concurrent requests each calling `createScopedKortix` with a different
 * token never see each other's config, even though both run in the same
 * process — unlike two concurrent `createKortix()` calls, which share (and
 * race on) the global singleton.
 */
/**
 * The top-level `runtime()` escape hatch resolves the PROCESS-GLOBAL "active"
 * runtime — whatever session most recently called `ensureReady()`. That's fine
 * for a single-tenant host (a browser tab, a CLI), but on a scoped client it is
 * a cross-tenant leak: in a multi-tenant server the "active" runtime is a
 * DIFFERENT request's/end-user's sandbox, and `wrapScoped` only scopes the token,
 * not this global URL resolution. A scoped client has no single ambient session,
 * so there is no safe top-level runtime — reach a specific session's runtime via
 * `kortix.session(projectId, sessionId).runtime` (await `.ensureReady()` first),
 * which resolves that session's OWN sandbox and never the global.
 */
function scopedRuntimeUnavailable(): never {
  throw new Error(
    'kortix.runtime() is not available on a @kortix/sdk/server (scoped) client: it resolves the ' +
      "process-global active runtime, which in a multi-tenant server is another request's sandbox. " +
      "Reach a specific session's runtime via `const s = kortix.session(projectId, sessionId); " +
      'await s.ensureReady(); s.runtime`.',
  );
}

export function createScopedKortix(config: KortixPlatformConfig): Kortix {
  const inner = createKortix(config, { global: false });
  const scoped = wrapScoped(inner, config, new WeakSet());
  // Neutralize the ambient top-level runtime() on the scoped surface (see
  // scopedRuntimeUnavailable). The session-scoped `session(pid, sid).runtime`
  // getter is untouched — it resolves its own sandbox, never the global.
  scoped.runtime = scopedRuntimeUnavailable;
  return scoped;
}
