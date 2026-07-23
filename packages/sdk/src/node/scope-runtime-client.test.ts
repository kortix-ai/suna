import { describe, expect, test } from 'bun:test';
import type { KortixPlatformConfig } from '../core/http/config';
// Importing this module registers the AsyncLocalStorage config resolver as an
// import-time side effect (via ../platform/config-node), so `getScopedConfig()`
// reflects the scope established by `scopeRuntimeClient`'s per-call `runScoped`.
import { scopeRuntimeClient } from './scope-runtime-client';
import { getScopedConfig } from '../platform/config-node';

function cfg(backendUrl: string): KortixPlatformConfig {
  return { backendUrl, getToken: async () => `tok-${backendUrl}` };
}

/** A stand-in for the opencode runtime client: nested namespaces whose methods
 *  report whichever config is active on the current async context — exactly
 *  what `authenticatedFetch` reads inside the real client. */
function fakeRuntimeClient() {
  return {
    session: {
      // Reads the ambient config AFTER an await, to prove the scope survives
      // the async continuation (the real client awaits fetch mid-method).
      prompt: async () => {
        await Promise.resolve();
        return getScopedConfig()?.backendUrl ?? null;
      },
    },
    app: {
      // `this`-dependent method — the proxy must invoke it with the real
      // namespace as receiver, not the proxy.
      base: 'app-base',
      get(this: { base: string }) {
        return `${this.base}:${getScopedConfig()?.backendUrl ?? 'none'}`;
      },
    },
  };
}

describe('scopeRuntimeClient', () => {
  test('binds every method call to the captured config, even when called out of scope', async () => {
    const scoped = scopeRuntimeClient(fakeRuntimeClient(), cfg('A'));
    // No ambient runScoped frame here — the proxy is the only thing that can
    // supply the config.
    expect(getScopedConfig()).toBeUndefined();
    expect(await scoped.session.prompt()).toBe('A');
    expect(scoped.app.get()).toBe('app-base:A');
  });

  test('the raw (unscoped) client sees no config out of scope — proves the proxy is what binds it', async () => {
    const raw = fakeRuntimeClient();
    expect(await raw.session.prompt()).toBeNull();
  });

  test('two scoped clients stay isolated under interleaving', async () => {
    const a = scopeRuntimeClient(fakeRuntimeClient(), cfg('A'));
    const b = scopeRuntimeClient(fakeRuntimeClient(), cfg('B'));
    const [ra, rb] = await Promise.all([a.session.prompt(), b.session.prompt()]);
    expect(ra).toBe('A');
    expect(rb).toBe('B');
  });

  test('nested namespaces keep referential identity across accesses', () => {
    const scoped = scopeRuntimeClient(fakeRuntimeClient(), cfg('A'));
    expect(scoped.session).toBe(scoped.session);
  });
});
