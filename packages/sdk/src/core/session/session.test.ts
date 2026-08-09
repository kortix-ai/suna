import { describe, expect, it } from 'bun:test';
import { configureKortix } from '../http/config';

// Stub the SDK's authenticatedFetch so getSessionHealth doesn't require a
// configured platform — same approach as files/client.test.ts.
let respond: () => Response = () => new Response('{}', { status: 200 });
configureKortix({
  backendUrl: 'http://sbx.test',
  getToken: async () => 'tok',
  fetch: (async () => respond()) as unknown as typeof fetch,
});

import { setCurrentRuntime } from './current-runtime';
import { getSessionHealth, isRuntimeReady } from './health';
import {
  rewriteLocalhostUrl,
  proxyLocalhostUrl,
  parseLocalhostUrl,
  hasPreviewTarget,
  isInternalLocalhostUrl,
  isPreviewUrl,
  isProxiableLocalhostUrl,
  buildStaticFilePreviewUrl,
  buildStaticFileHealthPreviewUrl,
  buildStaticFileLocalUrl,
  buildStaticFileServicePath,
} from './url';
import {
  buildPreviewAuthEndpoint,
  isSubdomainPreviewUrl,
  appendPreviewToken,
} from './preview';

describe('session/health', () => {
  it('isRuntimeReady reads runtimeReady / opencode / status', () => {
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

  // ── No sandbox id → no proxy URL ──
  //
  // Regression: with an unresolved runtime the sandbox-id slot went in empty and
  // produced `https://staging-api.kortix.com/v1/p//3000/` — a structurally
  // invalid proxy URL that 404s (`{"error":true,"message":"Not found"}`) while
  // looking to the reader like a real preview link. There is no valid preview
  // target without a sandbox id, so the only honest answer is to not rewrite.
  describe('with no resolvable sandbox id', () => {
    const noSandbox = { sandboxId: '', backendPort: 443, apiBaseUrl: 'https://staging-api.kortix.com/v1' };

    it('hasPreviewTarget is false, so callers can hold off instead of guessing', () => {
      expect(hasPreviewTarget(opts)).toBe(true);
      expect(hasPreviewTarget(noSandbox)).toBe(false);
      expect(hasPreviewTarget({ ...opts, sandboxId: '   ' })).toBe(false);
    });

    it('never emits the empty-slot path proxy URL', () => {
      const url = rewriteLocalhostUrl(3000, '/', noSandbox);
      expect(url).not.toContain('/p//');
      expect(url).toBe('http://localhost:3000/');
    });

    it('never emits the empty-slot subdomain proxy URL', () => {
      // `http://p3000-.localhost:8008/` is the subdomain-branch equivalent —
      // equally unroutable, equally invisible to the reader.
      const url = rewriteLocalhostUrl(3000, '/', {
        ...noSandbox,
        apiBaseUrl: 'http://localhost:8008/v1',
      });
      expect(url).not.toContain('p3000-.');
      expect(url).toBe('http://localhost:3000/');
    });

    it('leaves a localhost URL untouched so the click handler can retry once the runtime resolves', () => {
      expect(proxyLocalhostUrl('http://localhost:3000/', noSandbox)).toBe('http://localhost:3000/');
    });

    it('the un-rewritten URL is still recognized as proxiable, not as a dead end', () => {
      expect(isProxiableLocalhostUrl(proxyLocalhostUrl('http://localhost:3000/', noSandbox)!)).toBe(
        true,
      );
      expect(isPreviewUrl(rewriteLocalhostUrl(3000, '/', noSandbox))).toBe(false);
    });

    it('whitespace-only ids are treated as absent, not trimmed into the path', () => {
      expect(rewriteLocalhostUrl(3000, '/x', { ...noSandbox, sandboxId: '  ' })).toBe(
        'http://localhost:3000/x',
      );
    });

    it('the un-proxied result is flagged internal, so iframes refuse it', () => {
      expect(isInternalLocalhostUrl(rewriteLocalhostUrl(3000, '/', noSandbox))).toBe(true);
    });
  });

  describe('isInternalLocalhostUrl', () => {
    it('is true only for a bare localhost host with a port', () => {
      expect(isInternalLocalhostUrl('http://localhost:3000/')).toBe(true);
      expect(isInternalLocalhostUrl('http://127.0.0.1:8080/a/b?c=1')).toBe(true);
    });

    it('is false for the subdomain preview form — that host reaches kortix-api', () => {
      // The asymmetry that matters: `p3000-sbx1.localhost` is a PROXY hostname,
      // not the viewer's own machine. Treating it as internal would break every
      // local self-hosted preview.
      expect(isInternalLocalhostUrl('http://p3000-sbx1.localhost:8008/x')).toBe(false);
      expect(isInternalLocalhostUrl(rewriteLocalhostUrl(3000, '/x', {
        ...opts,
        apiBaseUrl: 'http://localhost:8008/v1',
      }))).toBe(false);
    });

    it('is false for path-based previews, remote hosts, and unparseable input', () => {
      expect(isInternalLocalhostUrl('https://api.kortix.cloud/v1/p/sbx1/3000/x')).toBe(false);
      expect(isInternalLocalhostUrl('https://example.com/')).toBe(false);
      expect(isInternalLocalhostUrl('http://localhost/')).toBe(false); // no port
      expect(isInternalLocalhostUrl('not a url')).toBe(false);
    });
  });
});

describe('session/preview', () => {
  it('buildPreviewAuthEndpoint derives the /p/auth endpoint', () => {
    expect(
      buildPreviewAuthEndpoint('http://localhost:8008/v1/p/sbx1/3000/index.html'),
    ).toBe('http://localhost:8008/v1/p/auth');
  });

  it('buildStaticFilePreviewUrl owns the static-file service route', () => {
    expect(buildStaticFilePreviewUrl('/workspace/reports/q1 report.html', {
      sandboxId: 'sbx1',
      backendPort: 8008,
      apiBaseUrl: 'http://localhost:8008/v1',
    })).toBe(
      'http://p3211-sbx1.localhost:8008/open?path=/workspace/reports/q1%20report.html',
    );
  });

  it('static-file helpers hide the service port and open route', () => {
    expect(buildStaticFileServicePath('/workspace/a b.html')).toBe(
      '/open?path=/workspace/a%20b.html',
    );
    expect(buildStaticFileLocalUrl('/workspace/a b.html')).toBe(
      'http://localhost:3211/open?path=/workspace/a%20b.html',
    );
    expect(buildStaticFileHealthPreviewUrl({
      sandboxId: 'sbx1',
      backendPort: 8008,
      apiBaseUrl: 'https://api.kortix.cloud/v1',
    })).toBe('https://api.kortix.cloud/v1/p/sbx1/3211/health');
  });

  it('isSubdomainPreviewUrl + appendPreviewToken', () => {
    expect(isSubdomainPreviewUrl('http://p3000-sbx1.localhost:8008/')).toBe(true);
    expect(appendPreviewToken('http://p3000-sbx1.localhost:8008/', 'TK')).toContain('token=TK');
  });
});
