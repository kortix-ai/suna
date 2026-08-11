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

mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    async resolveIngress(_externalId: string, request: { port: number; transport?: string; path?: string }) {
      resolveCalls.push(request);
      const isPty = request.transport === 'websocket' && request.path?.includes('/pty/');
      const effectivePort = isPty ? 9999 : request.port;
      return {
        url: `http://sandbox.local/${resolveCalls.length}`,
        headers: {},
        effectivePort,
        websocket: isPty ? { userContextQueryParam: '__kortix_user_context' } : undefined,
      };
    },
    routeIngress: () => ({ effectivePort: 8000 }),
  }),
}));

const { resolveSandboxIngress } = await import('./backend');

const BASE_RECORD = {
  sandboxId: 'sbx-1',
  agentName: null,
  sessionId: 'sess-1',
  workspaceId: 'proj-1',
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
