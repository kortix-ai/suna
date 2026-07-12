import { describe, expect, it, mock } from 'bun:test';
import * as realAuth from '../http/auth';

// Stub the SDK's authenticatedFetch so getSessionHealth doesn't require a
// configured platform — same approach as files/client.test.ts.
let respond: () => Response = () => new Response('{}', { status: 200 });
mock.module('../http/auth', () => ({
  ...realAuth,
  authenticatedFetch: async () => respond(),
}));

import { setCurrentRuntime } from './current-runtime';
import { getSessionHealth, isRuntimeReady } from './health';
import {
  rewriteLocalhostUrl,
  proxyLocalhostUrl,
  parseLocalhostUrl,
  isPreviewUrl,
} from './url';
import {
  buildPreviewAuthEndpoint,
  isSubdomainPreviewUrl,
  appendPreviewToken,
} from './preview';

describe('session/health', () => {
  it('isRuntimeReady reads runtimeReady / legacy opencode / status', () => {
    expect(isRuntimeReady({ runtimeReady: true })).toBe(true);
    expect(isRuntimeReady({ runtimeReady: false })).toBe(false);
    expect(isRuntimeReady({ opencode: 'ok' })).toBe(true);
    expect(isRuntimeReady({ status: 'starting' })).toBe(false);
    expect(isRuntimeReady({ status: 'ready' })).toBe(true);
    expect(isRuntimeReady(null)).toBe(false);
  });

  it('getSessionHealth parses a 200 body + reports ready', async () => {
    respond = () =>
      new Response(JSON.stringify({ status: 'ready', version: 'v9' }), { status: 200 });
    const r = await getSessionHealth('http://sbx.test');
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.health?.version).toBe('v9');
    expect(isRuntimeReady(r.health)).toBe(true);
  });

  it('getSessionHealth surfaces non-ok status without throwing', async () => {
    respond = () => new Response('no service is responding', { status: 503 });
    const r = await getSessionHealth('http://sbx.test');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(r.body).toContain('no service');
  });

  it('getSessionHealth short-circuits with no server url', async () => {
    const r = await getSessionHealth('');
    expect(r.status).toBe(0);
    expect(r.ok).toBe(false);
  });

  // Regression: a per-session handle's health() must never silently probe
  // whichever DIFFERENT session's sandbox is globally "active" — `null`
  // explicitly means "this session has no runtime yet", unlike omitting the
  // argument entirely (which intentionally still falls back, for callers that
  // aren't session-scoped).
  it('getSessionHealth never falls back to the active runtime when null is passed explicitly', async () => {
    setCurrentRuntime('http://some-other-sessions-sandbox.test', 'sb-other');
    respond = () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 });

    const r = await getSessionHealth(null);
    expect(r.status).toBe(0);
    expect(r.ok).toBe(false);

    setCurrentRuntime(null);
  });
});

describe('session/url', () => {
  const opts = { sandboxId: 'sbx1', backendPort: 8008, apiBaseUrl: 'https://api.kortix.cloud/v1' };

  it('path-based proxy when the backend is remote', () => {
    expect(rewriteLocalhostUrl(3000, '/x', opts)).toBe(
      'https://api.kortix.cloud/v1/p/sbx1/3000/x',
    );
  });

  it('subdomain proxy when the backend is local', () => {
    expect(
      rewriteLocalhostUrl(3000, '/x', { ...opts, apiBaseUrl: 'http://localhost:8008/v1' }),
    ).toBe('http://p3000-sbx1.localhost:8008/x');
  });

  it('parses + proxies a localhost url', () => {
    expect(parseLocalhostUrl('http://localhost:3000/foo')?.port).toBe(3000);
    expect(proxyLocalhostUrl('http://localhost:3000/foo', opts)).toBe(
      'https://api.kortix.cloud/v1/p/sbx1/3000/foo',
    );
  });

  it('isPreviewUrl recognizes proxied urls only', () => {
    expect(isPreviewUrl('https://api.kortix.cloud/v1/p/sbx1/3000/foo')).toBe(true);
    expect(isPreviewUrl('http://localhost:3000/foo')).toBe(false);
  });
});

describe('session/preview', () => {
  it('buildPreviewAuthEndpoint derives the /p/auth endpoint', () => {
    expect(
      buildPreviewAuthEndpoint('http://localhost:8008/v1/p/sbx1/3000/index.html'),
    ).toBe('http://localhost:8008/v1/p/auth');
  });

  it('isSubdomainPreviewUrl + appendPreviewToken', () => {
    expect(isSubdomainPreviewUrl('http://p3000-sbx1.localhost:8008/')).toBe(true);
    expect(appendPreviewToken('http://p3000-sbx1.localhost:8008/', 'TK')).toContain('token=TK');
  });
});
