import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import worker from './worker.mjs';

const env = {
  ACTIVE_BACKEND: 'eks',
  BACKEND_EKS: 'https://api-eks.kortix.com',
  BACKEND_ECS_FARGATE: 'https://api-fargate.kortix.com',
  BACKEND_US_EAST_2: 'https://api-use2-shadow.kortix.com',
  // Gateway is deliberately on a DIFFERENT active backend than the API, to prove
  // the two services flip independently.
  GATEWAY_ACTIVE_BACKEND: 'ecs-fargate',
  GATEWAY_BACKEND_EKS: 'https://gateway-eks.kortix.com',
  GATEWAY_BACKEND_ECS_FARGATE: 'https://gateway-fargate.kortix.com',
  GATEWAY_BACKEND_US_EAST_2: 'https://gateway-use2-shadow.kortix.com',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('api-router worker', () => {
  test('keeps the staging API on EKS in config and deployment metadata', () => {
    const wrangler = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
    const deployWorkflow = readFileSync(
      new URL('../../../../.github/workflows/deploy-staging.yml', import.meta.url),
      'utf8',
    );

    const stagingVars = wrangler.match(
      /\[env\.staging\.vars\]([\s\S]*?)(?=\n\[env\.|\s*$)/,
    )?.[1];
    expect(stagingVars).toContain('ACTIVE_BACKEND = "eks"');
    expect(deployWorkflow).toContain(
      '{type:"plain_text", name:"ACTIVE_BACKEND", text:"eks"}',
    );
  });

  test('keeps the prepared US East 2 origins inactive in production config', () => {
    const wrangler = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
    const productionVars = wrangler.match(
      /\[env\.prod\.vars\]([\s\S]*?)(?=\n\[env\.|\s*$)/,
    )?.[1];

    expect(productionVars).toContain('ACTIVE_BACKEND = "ecs-fargate"');
    expect(productionVars).toContain('GATEWAY_ACTIVE_BACKEND = "ecs-fargate"');
    expect(productionVars).toContain(
      'BACKEND_US_EAST_2 = "https://api-use2-shadow.kortix.com"',
    );
    expect(productionVars).toContain(
      'GATEWAY_BACKEND_US_EAST_2 = "https://gateway-use2-shadow.kortix.com"',
    );
    expect(productionVars).not.toContain('us-west-2');
    expect(productionVars).not.toContain('usw2');
  });

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
    expect(response.headers.get('X-Backend-Service')).toBe('api');
  });

  test('routes gateway hostnames to the gateway backend, independent of the API toggle', async () => {
    let proxiedUrl = '';
    globalThis.fetch = async (request) => {
      proxiedUrl = request.url;
      return new Response('ok', { status: 200 });
    };

    const response = await worker.fetch(
      new Request('https://gateway-dev.kortix.com/health/live'),
      env,
    );

    // API is on eks, but the gateway is on ecs-fargate → the gateway origin wins.
    expect(proxiedUrl).toBe('https://gateway-fargate.kortix.com/health/live');
    expect(response.headers.get('X-Backend')).toBe('ecs-fargate');
    expect(response.headers.get('X-Backend-Service')).toBe('gateway');
  });

  test('routes API and gateway requests to the prepared us-east-2 origins', async () => {
    const use2Env = {
      ...env,
      ACTIVE_BACKEND: 'us-east-2',
      GATEWAY_ACTIVE_BACKEND: 'us-east-2',
    };
    const proxiedUrls = [];
    globalThis.fetch = async (request) => {
      proxiedUrls.push(request.url);
      return new Response('ok', { status: 200 });
    };

    const apiResponse = await worker.fetch(
      new Request('https://api.kortix.com/v1/health'),
      use2Env,
    );
    const gatewayResponse = await worker.fetch(
      new Request('https://gateway.kortix.com/health/live'),
      use2Env,
    );

    expect(proxiedUrls).toEqual([
      'https://api-use2-shadow.kortix.com/v1/health',
      'https://gateway-use2-shadow.kortix.com/health/live',
    ]);
    expect(apiResponse.headers.get('X-Backend')).toBe('us-east-2');
    expect(gatewayResponse.headers.get('X-Backend')).toBe('us-east-2');
  });

  test('gateway HTTPS redirect keeps the gateway hostname', async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response('unexpected');
    };

    const response = await worker.fetch(
      new Request('http://gateway.kortix.com/v1/chat/completions'),
      env,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://gateway.kortix.com/v1/chat/completions');
    expect(fetched).toBe(false);
  });

  test('preserves API WebSocket upgrade responses without wrapping them', async () => {
    const webSocket = {};
    const upgradeResponse = {
      status: 101,
      headers: new Headers(),
      webSocket,
    };
    let proxiedUrl = '';
    let proxiedUpgrade = '';
    globalThis.fetch = async (request) => {
      proxiedUrl = request.url;
      proxiedUpgrade = request.headers.get('Upgrade') ?? '';
      return upgradeResponse;
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/p/sbx_123/8000/kortix/pty/kpty_123/connect', {
        headers: { Upgrade: 'websocket' },
      }),
      env,
    );

    expect(proxiedUrl).toBe(
      'https://api-eks.kortix.com/v1/p/sbx_123/8000/kortix/pty/kpty_123/connect',
    );
    expect(proxiedUpgrade).toBe('websocket');
    expect(response).toBe(upgradeResponse);
    expect(response.webSocket).toBe(webSocket);
  });
});
