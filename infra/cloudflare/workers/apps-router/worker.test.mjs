import { afterEach, describe, expect, test } from 'bun:test';
import worker, { signAppRequest } from './worker.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const env = {
  DEV_EDGE_SECRET: 'test-dev-edge-secret-at-least-sixteen',
  STAGING_EDGE_SECRET: 'test-staging-edge-secret-at-least-sixteen',
  PROD_EDGE_SECRET: 'test-prod-edge-secret-at-least-sixteen',
  PREVIEW_EDGE_SECRET: 'test-preview-edge-secret-at-least-sixteen',
  DEV_API_ORIGIN: 'https://dev-api.kortix.com',
  STAGING_API_ORIGIN: 'https://staging-api.kortix.com',
  PROD_API_ORIGIN: 'https://api.kortix.com',
  PREVIEW_API_ORIGIN: 'https://dev-api.kortix.com',
};

describe('Kortix Apps Cloudflare router', () => {
  test('selects the API by the hostname environment and replaces internal headers', async () => {
    let forwarded;
    globalThis.fetch = async (request) => {
      forwarded = request;
      return new Response('hello', { status: 200 });
    };
    const request = new Request(
      'https://dev-hello-0123456789abcdef.apps.kortix.com/path?q=1',
      { headers: { 'x-kortix-app-signature': 'caller-controlled' } },
    );
    const response = await worker.fetch(request, env);

    expect(forwarded.url).toBe('https://dev-api.kortix.com/path?q=1');
    expect(forwarded.headers.get('x-kortix-app-host')).toBe(
      'dev-hello-0123456789abcdef.apps.kortix.com',
    );
    expect(forwarded.headers.get('x-kortix-app-signature')).not.toBe('caller-controlled');
    const timestamp = forwarded.headers.get('x-kortix-app-timestamp');
    expect(forwarded.headers.get('x-kortix-app-signature')).toBe(
      await signAppRequest(request, timestamp, env.DEV_EDGE_SECRET),
    );
    expect(response.headers.get('x-kortix-app-environment')).toBe('dev');
    expect(response.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*",
    );
    expect(response.headers.get('x-frame-options')).toBeNull();
  });

  test('replaces upstream framing restrictions and preserves other CSP directives', async () => {
    globalThis.fetch = async () => new Response('hello', {
      status: 200,
      headers: {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors https://example.com",
      },
    });

    const response = await worker.fetch(
      new Request('https://dev-hello-0123456789abcdef.apps.kortix.com/'),
      env,
    );

    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*",
    );
  });

  test('signs method, host, path, and query deterministically', async () => {
    const request = new Request('https://prod-app-0123456789abcdef.apps.kortix.com/api?q=1', {
      method: 'POST',
    });
    const first = await signAppRequest(request, '1234', env.PROD_EDGE_SECRET);
    expect(first).toBe(await signAppRequest(request, '1234', env.PROD_EDGE_SECRET));
    expect(first).not.toBe(await signAppRequest(
      new Request('https://prod-app-0123456789abcdef.apps.kortix.com/other?q=1', { method: 'POST' }),
      '1234',
      env.PROD_EDGE_SECRET,
    ));
  });

  test('rejects unrecognized environment labels', async () => {
    const response = await worker.fetch(
      new Request('https://qa-app-0123456789abcdef.apps.kortix.com/'),
      env,
    );
    expect(response.status).toBe(404);
  });
});
