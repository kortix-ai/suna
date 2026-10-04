// The preview-link cache is keyed per (sandboxId, port, transport[, path]).
// `path` used to always be folded in, which fragmented the HTTP cache into
// one entry per distinct request path even though every provider's http
// resolveIngress ignores `path` entirely — the box's warm-preview link is the
// same regardless of which route the browser is fetching. On the websocket
// transport, though, Platinum's routeIngress branches on `path`
// (classifyPtyWebSocketPath) to pick AGENT_PORT + a different `websocket`
// config for PTY vs non-PTY sockets, so `path` must stay in the key there —
// dropping it would collide the two onto one cache entry and hand back the
// wrong upstream port.
//
// The heavier ../config + ../shared/db deps are mocked to inert stubs since
// this suite passes a SandboxRecord directly (bypassing loadSandbox's db
// query). `bun:test`'s mock.module is process-global, so this lives in its
// own file, same caveat other sandbox-proxy tests document.
import { describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
import * as realProviders from '../platform/providers';
import * as realPreviewOwnership from '../shared/preview-ownership';
import * as realKortixUserContext from '../shared/kortix-user-context';

mock.module('../config', () => ({ config: {} }));
mock.module('../shared/db', () => ({ db: {} }));
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  resolvePreviewUserContext: async () => null,
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
// Overriding only what this file needs keeps new exports working by default.
mock.module('../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
  encodeKortixUserContext: () => '',
}));

let resolveCalls: Array<{ port: number; transport?: string; path?: string }> = [];
// Held open by the single-flight tests so calls overlap; the failure is thrown
// by the next provider call only.
let resolveGate: Promise<void> | null = null;
let resolveFailure: Error | null = null;

mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: (provider: string) => ({
    ingressCacheTtlMs: provider === 'e2b' ? 0 : undefined,
    async resolveIngress(_externalId: string, request: { port: number; transport?: string; path?: string }) {
      resolveCalls.push(request);
      const url = `http://sandbox.local/${resolveCalls.length}`;
      const failure = resolveFailure;
      resolveFailure = null;
      await resolveGate;
      if (failure) throw failure;
      const isPty = request.transport === 'websocket' && request.path?.includes('/pty/');
      const effectivePort = isPty ? 9999 : request.port;
      return {
        url,
        headers: {},
        effectivePort,
        websocket: isPty ? { userContextQueryParam: '__kortix_user_context' } : undefined,
      };
    },
    routeIngress: () => ({ effectivePort: 8000 }),
  }),
}));

const { invalidatePreviewLink, resolveSandboxIngress } = await import('./backend');

const BASE_RECORD = {
  sandboxId: 'sbx-1',
  agentName: null,
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  provider: 'platinum',
  status: 'active',
  baseUrl: '',
  serviceKey: 'svc-key',
};

describe('resolveSandboxIngress cache key — http', () => {
  test('two different http paths on the same (sandbox, port) share one cache entry', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, externalId: 'ext-http-1' };
    const first = await resolveSandboxIngress(record, { port: 8000, transport: 'http', path: '/foo' });
    const second = await resolveSandboxIngress(record, { port: 8000, transport: 'http', path: '/bar' });
    expect(resolveCalls.length).toBe(1);
    expect(second).toEqual(first);
  });

  test('E2B ingress bypasses the outer cache so rotated traffic tokens can refresh', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, provider: 'e2b', externalId: 'ext-e2b-token-rotation' };

    await resolveSandboxIngress(record, { port: 8000, transport: 'http', path: '/foo' });
    await resolveSandboxIngress(record, { port: 8000, transport: 'http', path: '/bar' });

    expect(resolveCalls.length).toBe(2);
  });
});

describe('resolveSandboxIngress cache key — websocket', () => {
  test('a PTY path and a non-PTY path on the same (sandbox, port) do not share an entry', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, externalId: 'ext-ws-1' };
    const pty = await resolveSandboxIngress(record, {
      port: 8000,
      transport: 'websocket',
      path: '/pty/pty_1/connect',
    });
    const nonPty = await resolveSandboxIngress(record, {
      port: 8000,
      transport: 'websocket',
      path: '/other/socket',
    });
    expect(resolveCalls.length).toBe(2);
    expect(pty.effectivePort).toBe(9999);
    expect(nonPty.effectivePort).toBe(8000);
  });

  test('repeating the same PTY path is still cached (only one resolve call)', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, externalId: 'ext-ws-2' };
    const request = { port: 8000, transport: 'websocket' as const, path: '/pty/pty_2/connect' };
    const first = await resolveSandboxIngress(record, request);
    const second = await resolveSandboxIngress(record, request);
    expect(resolveCalls.length).toBe(1);
    expect(second).toEqual(first);
  });
});

// A page load fires its proxied requests together. On a cold link cache every
// one of them used to make its own provider call for the same link.
describe('resolveSandboxIngress single-flight', () => {
  /** Hold every provider call open until `release()`. */
  function holdProvider(): () => void {
    let release = () => {};
    resolveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      release();
      resolveGate = null;
    };
  }

  test('concurrent misses on one (sandbox, port) make one provider call', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, externalId: 'ext-flight-1' };
    const release = holdProvider();

    const calls = Array.from({ length: 5 }, (_, i) =>
      resolveSandboxIngress(record, { port: 8000, transport: 'http', path: `/asset-${i}` }),
    );
    release();
    const resolved = await Promise.all(calls);

    expect(resolveCalls.length).toBe(1);
    for (const ingress of resolved) expect(ingress).toEqual(resolved[0]);
    // The shared result is cached like a single call's result.
    await resolveSandboxIngress(record, { port: 8000, transport: 'http' });
    expect(resolveCalls.length).toBe(1);
  });

  test('another port or another sandbox never joins a call in flight', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, externalId: 'ext-flight-2' };
    const other = { ...BASE_RECORD, externalId: 'ext-flight-3' };
    const release = holdProvider();

    const calls = [
      resolveSandboxIngress(record, { port: 8000, transport: 'http' }),
      resolveSandboxIngress(record, { port: 3000, transport: 'http' }),
      resolveSandboxIngress(other, { port: 8000, transport: 'http' }),
    ];
    release();
    const [daemon, app, otherDaemon] = await Promise.all(calls);

    expect(resolveCalls.length).toBe(3);
    expect(new Set([daemon.url, app.url, otherDaemon.url]).size).toBe(3);
  });

  test('a failed provider call is not kept: every waiter gets the error, the next call resolves again', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, externalId: 'ext-flight-4' };
    const release = holdProvider();
    resolveFailure = new Error('provider unavailable');

    const outcomes = Promise.allSettled([
      resolveSandboxIngress(record, { port: 8000, transport: 'http' }),
      resolveSandboxIngress(record, { port: 8000, transport: 'http' }),
    ]);
    release();
    expect((await outcomes).map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(resolveCalls.length).toBe(1);

    const ingress = await resolveSandboxIngress(record, { port: 8000, transport: 'http' });
    expect(resolveCalls.length).toBe(2);
    expect(ingress.url).toBe('http://sandbox.local/2');
  });

  test('a provider that opts out of the cache still shares one call between concurrent misses', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, provider: 'e2b', externalId: 'ext-flight-5' };
    const release = holdProvider();

    const calls = [
      resolveSandboxIngress(record, { port: 8000, transport: 'http' }),
      resolveSandboxIngress(record, { port: 8000, transport: 'http' }),
    ];
    release();
    await Promise.all(calls);
    expect(resolveCalls.length).toBe(1);

    // Nothing was cached: the next call asks the provider again.
    await resolveSandboxIngress(record, { port: 8000, transport: 'http' });
    expect(resolveCalls.length).toBe(2);
  });

  test('a link invalidated while its call is in flight is not joined and not cached', async () => {
    resolveCalls = [];
    const record = { ...BASE_RECORD, externalId: 'ext-flight-6' };
    const release = holdProvider();

    const before = resolveSandboxIngress(record, { port: 8000, transport: 'http' });
    invalidatePreviewLink('ext-flight-6', 8000);
    const after = resolveSandboxIngress(record, { port: 8000, transport: 'http' });
    release();

    expect((await before).url).toBe('http://sandbox.local/1');
    expect((await after).url).toBe('http://sandbox.local/2');
    // The cache holds the call made after the invalidation.
    expect((await resolveSandboxIngress(record, { port: 8000, transport: 'http' })).url).toBe(
      'http://sandbox.local/2',
    );
    expect(resolveCalls.length).toBe(2);
  });
});
