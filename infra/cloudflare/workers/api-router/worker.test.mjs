import { afterEach, describe, expect, test } from 'bun:test';
import worker from './worker.mjs';

const env = {
  ACTIVE_BACKEND: 'eks',
  BACKEND_EKS: 'https://api-eks.kortix.com',
  BACKEND_ECS_FARGATE: 'https://api-fargate.kortix.com',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('api-router worker', () => {
  test('redirects plaintext API requests to HTTPS before proxying', async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response('unexpected');
    };

    const response = await worker.fetch(
      new Request('http://api.kortix.com/v1/health/live?x=1'),
      env,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://api.kortix.com/v1/health/live?x=1');
    expect(fetched).toBe(false);
  });

  test('adds API security headers to proxied HTTPS responses', async () => {
    let proxiedUrl = '';
    globalThis.fetch = async (request) => {
      proxiedUrl = request.url;
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/health/live'),
      env,
    );

    expect(proxiedUrl).toBe('https://api-eks.kortix.com/v1/health/live');
    expect(response.status).toBe(200);
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Backend')).toBe('eks');
  });
});
