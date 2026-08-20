import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];
let responseFactory: () => Response;

beforeEach(() => {
  requests.splice(0);
  responseFactory = () => Response.json({ ok: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return responseFactory();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const boundary = await import('./host-boundary');

describe('host boundary transport', () => {
  test('public marketplace reads accept explicit cache options', async () => {
    responseFactory = () => Response.json({ items: [{ id: 'skill-1' }] });
    const result = await boundary.listPublicMarketplaceItems(
      { backendUrl: 'https://api.example.test/v1', cache: 'force-cache' },
      { type: 'skill', limit: 48 },
    );

    expect(result.items).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.example.test/v1/marketplace/items?type=skill&limit=48',
    );
    expect(requests[0]?.init?.cache).toBe('force-cache');
  });

  test('authenticated writes own bearer headers and JSON encoding', async () => {
    await boundary.submitOAuthConsent(
      { requestId: 'req-1', approved: true },
      { backendUrl: 'https://api.example.test/v1', accessToken: 'token-1' },
    );

    expect(requests[0]?.url).toBe('https://api.example.test/v1/oauth/authorize/consent');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ request_id: 'req-1', approved: true }));
  });

  test('setup-link and public-share reads stay anonymous', async () => {
    await boundary.getConnectorSetupLink('connect-token', {
      backendUrl: 'https://api.example.test/v1',
    });
    await boundary.getPublicShareByToken('share-token', {
      backendUrl: 'https://api.example.test/v1',
    });

    expect(requests.map((request) => request.url)).toEqual([
      'https://api.example.test/v1/setup-links/connectors/connect-token',
      'https://api.example.test/v1/p/public-share/share-token',
    ]);
    expect(requests[0]?.init?.headers).not.toHaveProperty('Authorization');
    expect(requests[1]?.init?.headers).not.toHaveProperty('Authorization');
  });

  test('connector setup-link finalize POSTs anonymously and returns the connected flag', async () => {
    responseFactory = () => Response.json({ connected: true });

    const result = await boundary.finalizeConnectorSetupLink('connect-token', {
      backendUrl: 'https://api.example.test/v1',
    });

    expect(result).toEqual({ connected: true });
    expect(requests[0]?.url).toBe(
      'https://api.example.test/v1/setup-links/connectors/connect-token/finalize',
    );
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.headers).not.toHaveProperty('Authorization');
  });

  test('connector setup-link finalize reports a still-pending connect as connected:false', async () => {
    responseFactory = () => Response.json({ connected: false });

    const result = await boundary.finalizeConnectorSetupLink('connect-token', {
      backendUrl: 'https://api.example.test/v1',
    });

    expect(result).toEqual({ connected: false });
  });

  test('public-share file URLs join the API origin to the server-issued proxy path', () => {
    expect(
      boundary.buildPublicShareFileUrl(
        'https://api.example.test/v1',
        '/v1/p/public-share/kps_abc/file',
      ),
    ).toBe('https://api.example.test/v1/p/public-share/kps_abc/file');
    // The proxy path already carries `/v1`, so a bare or trailing-slash base
    // must not contribute a second one.
    expect(
      boundary.buildPublicShareFileUrl(
        'https://api.example.test/',
        '/v1/p/public-share/kps_abc/file',
      ),
    ).toBe('https://api.example.test/v1/p/public-share/kps_abc/file');
    expect(
      boundary.buildPublicShareFileUrl(
        'https://api.example.test/v1',
        'v1/p/public-share/kps_abc/file/nested%20asset.png',
      ),
    ).toBe('https://api.example.test/v1/p/public-share/kps_abc/file/nested%20asset.png');
    // `public_url` fallback: already absolute, so it is passed through.
    expect(
      boundary.buildPublicShareFileUrl('https://api.example.test/v1', 'https://cdn.example.test/x'),
    ).toBe('https://cdn.example.test/x');
  });

  test('public-share file URL rejects a backend URL it cannot resolve an origin from', () => {
    try {
      boundary.buildPublicShareFileUrl('', '/v1/p/public-share/kps_abc/file');
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(boundary.HostBoundaryError);
      expect((err as InstanceType<typeof boundary.HostBoundaryError>).status).toBe(400);
    }
  });

  test('public-share file reads stay anonymous and uncached', async () => {
    responseFactory = () =>
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });

    const response = await boundary.fetchPublicShareFile(
      'https://api.example.test/v1',
      '/v1/p/public-share/kps_abc/file',
    );

    expect(await response.text()).toBe('hello');
    expect(requests[0]?.url).toBe('https://api.example.test/v1/p/public-share/kps_abc/file');
    expect(requests[0]?.init?.cache).toBe('no-store');
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBeNull();
  });

  test('public-share file text read reports the served MIME type', async () => {
    responseFactory = () =>
      new Response('# title', {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });

    const result = await boundary.readPublicShareFileText(
      'https://api.example.test/v1',
      '/v1/p/public-share/kps_abc/file',
    );

    expect(result).toEqual({ text: '# title', mimeType: 'text/markdown; charset=utf-8' });
  });

  test('public-share file blob read falls back to a binary MIME type', async () => {
    responseFactory = () => new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });

    const result = await boundary.readPublicShareFileBlob(
      'https://api.example.test/v1',
      '/v1/p/public-share/kps_abc/file',
    );

    expect(result.mimeType).toBe('application/octet-stream');
    expect(await result.blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  test('a revoked public-share file surfaces the typed boundary error', async () => {
    responseFactory = () => Response.json({ error: 'Share link revoked' }, { status: 410 });

    try {
      await boundary.fetchPublicShareFile(
        'https://api.example.test/v1',
        '/v1/p/public-share/kps_abc/file',
      );
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(boundary.HostBoundaryError);
      const boundaryError = err as InstanceType<typeof boundary.HostBoundaryError>;
      expect(boundaryError.status).toBe(410);
      expect(boundaryError.message).toBe('Share link revoked');
      expect(boundaryError.body).toEqual({ error: 'Share link revoked' });
    }
  });

  test('audit export sends project and session reconstruction filters', async () => {
    responseFactory = () =>
      new Response('', {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'x-audit-next-cursor': '2026-08-07T12:00:00.000Z|event-1',
          'x-audit-complete': 'false',
        },
      });

    await boundary.downloadAccountAudit(
      'account-1',
      {
        format: 'csv',
        project_id: 'project-1',
        session_id: 'session-1',
        actor_type: 'agent',
        source: 'connector',
        phase: 'completed',
        outcome: 'failure',
        cursor: 'cursor-1',
        limit: 500,
      },
      { backendUrl: 'https://api.example.test/v1', accessToken: 'token-1' },
    );

    const url = new URL(requests[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: 'csv',
      project_id: 'project-1',
      session_id: 'session-1',
      actor_type: 'agent',
      source: 'connector',
      phase: 'completed',
      outcome: 'failure',
      cursor: 'cursor-1',
      limit: '500',
    });
    const result = await boundary.downloadAccountAudit(
      'account-1',
      { format: 'csv' },
      { backendUrl: 'https://api.example.test/v1', accessToken: 'token-1' },
    );
    expect(result.complete).toBe(false);
    expect(result.nextCursor).toBe('2026-08-07T12:00:00.000Z|event-1');
  });
});
