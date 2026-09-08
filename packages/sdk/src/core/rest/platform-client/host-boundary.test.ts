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
