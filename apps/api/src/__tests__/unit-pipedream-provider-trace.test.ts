import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PipedreamProvider } from '../integrations/providers/pipedream';
import { runWithContext } from '../lib/request-context';

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider() {
  return new PipedreamProvider({
    clientId: 'pd-client',
    clientSecret: 'pd-secret',
    projectId: 'pd-project',
    environment: 'development',
  });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: headersToObject(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (url.endsWith('/v1/oauth/token')) {
      return json({ access_token: 'pd-token', expires_in: 3600 });
    }

    if (url.includes('/v1/connect/pd-project/apps?')) {
      return json({
        page_info: { total_count: 1, count: 1 },
        data: [
          {
            name_slug: 'slack',
            name: 'Slack',
            categories: ['communication'],
          },
        ],
      });
    }

    if (url.includes('/v1/connect/pd-project/proxy/')) {
      return json({ ok: true });
    }

    return json({ error: 'unexpected test URL' }, 500);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('PipedreamProvider trace propagation', () => {
  test('forwards normalized trace headers to token and API requests', async () => {
    await runWithContext(
      'GET',
      '/v1/router/connectors/search-apps',
      async () => {
        await provider().listApps('slack', 10);
      },
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.traceparent).toMatch(/^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/);
      expect(call.headers.traceparent).not.toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
      expect(call.headers['x-request-id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    }
  });

  test('strips caller-controlled trace headers from connector proxy payloads', async () => {
    await runWithContext(
      'POST',
      '/v1/router/connectors/proxy',
      async () => {
        await provider().proxyRequest(
          'account-1',
          'slack',
          {
            method: 'POST',
            url: 'https://slack.com/api/chat.postMessage',
            headers: {
              traceparent: '00-ffffffffffffffffffffffffffffffff-eeeeeeeeeeeeeeee-01',
              'X-Request-Id': 'caller-controlled',
              'X-Custom': 'ok',
            },
            body: { text: 'hello' },
          },
          'apn_slack_123',
        );
      },
      '00-11111111111111111111111111111111-2222222222222222-01',
    );

    expect(calls).toHaveLength(2);
    const proxyCall = calls[1];
    expect(proxyCall.headers.traceparent).toMatch(/^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/);
    expect(proxyCall.headers['x-request-id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(proxyCall.headers['x-pd-proxy-x-custom']).toBe('ok');
    expect(proxyCall.headers['x-pd-proxy-traceparent']).toBeUndefined();
    expect(proxyCall.headers['x-pd-proxy-x-request-id']).toBeUndefined();
  });
});
