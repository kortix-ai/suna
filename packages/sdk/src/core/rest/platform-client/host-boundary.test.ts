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

    expect(requests[0]?.url).toBe(
      'https://api.example.test/v1/oauth/authorize/consent',
    );
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(requests[0]?.init?.body).toBe(
      JSON.stringify({ request_id: 'req-1', approved: true }),
    );
  });

  test('setup-link and public-share reads stay anonymous', async () => {
    await boundary.getConnectorSetupLink(
      'connect-token',
      { backendUrl: 'https://api.example.test/v1' },
    );
    await boundary.getPublicShareByToken(
      'share-token',
      { backendUrl: 'https://api.example.test/v1' },
    );

    expect(requests.map((request) => request.url)).toEqual([
      'https://api.example.test/v1/setup-links/connector/connect-token',
      'https://api.example.test/v1/p/public-share/share-token',
    ]);
    expect(requests[0]?.init?.headers).not.toHaveProperty('Authorization');
    expect(requests[1]?.init?.headers).not.toHaveProperty('Authorization');
  });

  test('audit export sends project and session reconstruction filters', async () => {
    responseFactory = () =>
      new Response('', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });

    await boundary.downloadAccountAudit(
      'account-1',
      {
        format: 'csv',
        project_id: 'project-1',
        session_id: 'session-1',
        actor_type: 'agent',
        source: 'executor',
        outcome: 'failure',
      },
      { backendUrl: 'https://api.example.test/v1', accessToken: 'token-1' },
    );

    const url = new URL(requests[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: 'csv',
      project_id: 'project-1',
      session_id: 'session-1',
      actor_type: 'agent',
      source: 'executor',
      outcome: 'failure',
    });
  });
});
