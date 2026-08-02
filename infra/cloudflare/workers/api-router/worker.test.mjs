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

function fetchUrl(input) {
  return typeof input === 'string' ? input : input.url;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('api-router worker', () => {
  test('keeps the staging API on EKS in config and deployment metadata', () => {
    const wrangler = readFileSync(
      new URL('./wrangler.toml', import.meta.url),
      'utf8',
    );
    const deployWorkflow = readFileSync(
      new URL(
        '../../../../.github/workflows/deploy-staging.yml',
        import.meta.url,
      ),
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
    const wrangler = readFileSync(
      new URL('./wrangler.toml', import.meta.url),
      'utf8',
    );
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

  test('removes stale ECS commit overrides and verifies both shadow commits', () => {
    const ecsDeploy = readFileSync(
      new URL('../../../scripts/ecs-deploy.sh', import.meta.url),
      'utf8',
    );
    const shadowWorkflow = readFileSync(
      new URL(
        '../../../../.github/workflows/deploy-prod-us-east-2-shadow.yml',
        import.meta.url,
      ),
      'utf8',
    );

    expect(ecsDeploy).toContain(
      'select(.name != "KORTIX_VERSION" and .name != "KORTIX_COMMIT")',
    );
    expect(shadowWorkflow).toContain(
      'api_commit="$(jq -r \'.commit // empty\'',
    );
    expect(shadowWorkflow).toContain(
      '[ "$api_commit" != "$SOURCE_SHA" ] || [ "$gateway_commit" != "$SOURCE_SHA" ]',
    );
  });

  test('runs privileged US workflows only from the protected prod branch', () => {
    const workflows = [
      'activate-prod-us-east-2-writers.yml',
      'cutover-prod-us-east-2.yml',
      'deploy-prod-us-east-2-shadow.yml',
      'finalize-prod-us-east-2-database.yml',
      'reconcile-prod-us-east-2-shadow.yml',
    ];

    for (const workflow of workflows) {
      const source = readFileSync(
        new URL(`../../../../.github/workflows/${workflow}`, import.meta.url),
        'utf8',
      );
      expect(source).toContain('ref: prod');
      expect(source).toContain(
        'if [ "$GITHUB_REF" != "refs/heads/prod" ]; then',
      );
      expect(source).toContain('environment: prod-use2-shadow');
    }
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
    expect(response.headers.get('Location')).toBe(
      'https://api.kortix.com/v1/health/live?x=1',
    );
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
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000',
    );
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

  test('serves the independent maintenance state without contacting the API origin', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_STATE_URL: 'https://kortix.com/api/maintenance',
    };
    const fetchedUrls = [];
    globalThis.fetch = async (request) => {
      fetchedUrls.push(fetchUrl(request));
      if (
        fetchUrl(request) === 'https://api-eks.kortix.com/v1/system/maintenance'
      ) {
        return new Response('unavailable', { status: 503 });
      }
      return Response.json({
        level: 'blocking',
        title: 'Database maintenance',
        message: 'Writes are paused.',
        updatedAt: '2026-07-26T15:00:00.000Z',
      });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/system/maintenance'),
      maintenanceEnv,
    );

    expect(fetchedUrls).toEqual([
      'https://api-eks.kortix.com/v1/system/maintenance',
      'https://kortix.com/api/maintenance',
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Maintenance-Source')).toBe('edge-config');
    expect(await response.json()).toMatchObject({
      level: 'blocking',
      message: 'Writes are paused.',
    });
  });

  test('serves the database maintenance state before Edge Config', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_STATE_URL: 'https://kortix.com/api/maintenance/edge',
    };
    const fetchedUrls = [];
    globalThis.fetch = async (request) => {
      fetchedUrls.push(fetchUrl(request));
      return Response.json({
        level: 'none',
        title: '',
        message: '',
        updatedAt: '2026-07-26T15:00:00.000Z',
      });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/system/maintenance'),
      maintenanceEnv,
    );

    expect(fetchedUrls).toEqual([
      'https://api-eks.kortix.com/v1/system/maintenance',
    ]);
    expect(response.headers.get('X-Maintenance-Source')).toBe('database');
    expect(await response.json()).toMatchObject({ level: 'none' });
  });

  test('returns none (not automatic blocking) when database is unavailable and Edge Config is none', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_STATE_URL: 'https://kortix.com/api/maintenance/edge',
    };
    globalThis.fetch = async (request) => {
      if (
        fetchUrl(request) === 'https://api-eks.kortix.com/v1/system/maintenance'
      ) {
        return new Response('unavailable', { status: 503 });
      }
      return Response.json({
        level: 'none',
        title: '',
        message: '',
        updatedAt: '2026-07-26T15:00:00.000Z',
      });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/system/maintenance'),
      maintenanceEnv,
    );

    // Prefer the Edge Config state (none) over automatic blocking, so a
    // transient API blip doesn't trigger a full lockdown.
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Maintenance-Source')).toBe('edge-config');
    expect(await response.json()).toMatchObject({ level: 'none' });
  });

  test('allows the authenticated maintenance update route through the blocking gate', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_LEVEL_OVERRIDE: 'blocking',
    };
    const fetchedUrls = [];
    globalThis.fetch = async (request) => {
      fetchedUrls.push(fetchUrl(request));
      return Response.json({ level: 'none' });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/system/maintenance', {
        method: 'PUT',
        body: JSON.stringify({ level: 'none' }),
      }),
      maintenanceEnv,
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toEqual([
      'https://api-eks.kortix.com/v1/system/maintenance',
    ]);
  });

  test('blocks API and gateway writes while blocking maintenance is active', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_STATE_URL: 'https://kortix.com/api/maintenance',
    };
    const fetchedUrls = [];
    globalThis.fetch = async (request) => {
      fetchedUrls.push(fetchUrl(request));
      return Response.json({
        level: 'blocking',
        title: 'Database maintenance',
        message: 'Writes are paused.',
        updatedAt: '2026-07-26T15:00:00.000Z',
      });
    };

    const apiResponse = await worker.fetch(
      new Request('https://api.kortix.com/v1/projects', {
        method: 'POST',
        headers: { Origin: 'https://kortix.com' },
      }),
      maintenanceEnv,
    );
    const gatewayResponse = await worker.fetch(
      new Request('https://gateway.kortix.com/v1/chat/completions', {
        method: 'POST',
      }),
      maintenanceEnv,
    );

    expect(fetchedUrls).toEqual([
      'https://kortix.com/api/maintenance',
      'https://kortix.com/api/maintenance',
    ]);
    expect(apiResponse.status).toBe(503);
    expect(apiResponse.headers.get('X-Maintenance-Mode')).toBe('blocking');
    expect(apiResponse.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://kortix.com',
    );
    expect(gatewayResponse.status).toBe(503);
    expect(await gatewayResponse.json()).toMatchObject({
      error: 'MAINTENANCE_MODE',
      message: 'Writes are paused.',
    });
  });

  test('uses the blocking override without contacting the independent state endpoint', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_STATE_URL: 'https://kortix.com/api/maintenance',
      MAINTENANCE_LEVEL_OVERRIDE: 'blocking',
      MAINTENANCE_MESSAGE_OVERRIDE:
        'Final database synchronization is running.',
    };
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response('unexpected');
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/projects', { method: 'POST' }),
      maintenanceEnv,
    );

    expect(fetched).toBe(false);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      message: 'Final database synchronization is running.',
      maintenance: { level: 'blocking' },
    });
  });

  test('keeps read-only API requests available during blocking maintenance', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_STATE_URL: 'https://kortix.com/api/maintenance',
    };
    const fetchedUrls = [];
    globalThis.fetch = async (request) => {
      fetchedUrls.push(fetchUrl(request));
      if (fetchUrl(request) === maintenanceEnv.MAINTENANCE_STATE_URL) {
        return Response.json({
          level: 'blocking',
          title: 'Database maintenance',
          message: 'Writes are paused.',
          updatedAt: '2026-07-26T15:00:00.000Z',
        });
      }
      return Response.json({ accounts: [] });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts'),
      maintenanceEnv,
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toEqual([
      'https://kortix.com/api/maintenance',
      'https://api-eks.kortix.com/v1/accounts',
    ]);
  });

  test('fails open when the independent maintenance state is unavailable', async () => {
    const maintenanceEnv = {
      ...env,
      MAINTENANCE_STATE_URL: 'https://kortix.com/api/maintenance',
    };
    const fetchedUrls = [];
    globalThis.fetch = async (request) => {
      fetchedUrls.push(fetchUrl(request));
      if (fetchUrl(request) === maintenanceEnv.MAINTENANCE_STATE_URL) {
        return new Response('unavailable', { status: 503 });
      }
      return Response.json({ created: true }, { status: 201 });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/projects', { method: 'POST' }),
      maintenanceEnv,
    );

    // A transient Edge Config / state URL failure should not trigger a
    // full maintenance lockdown. The request passes through to the origin.
    expect(response.status).toBe(201);
    expect(fetchedUrls).toEqual([
      'https://kortix.com/api/maintenance',
      'https://api-eks.kortix.com/v1/projects',
    ]);
  });

  test('converts an unavailable API origin into a maintenance response', async () => {
    const fetchedUrls = [];
    globalThis.fetch = async (request) => {
      fetchedUrls.push(fetchUrl(request));
      return new Response('Service Temporarily Unavailable', { status: 503 });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts'),
      env,
    );

    expect(fetchedUrls).toEqual(['https://api-eks.kortix.com/v1/accounts']);
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toMatchObject({
      error: 'MAINTENANCE_MODE',
      maintenance: { level: 'blocking' },
    });
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
    expect(response.headers.get('Location')).toBe(
      'https://gateway.kortix.com/v1/chat/completions',
    );
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
      new Request(
        'https://api.kortix.com/v1/p/sbx_123/8000/kortix/pty/kpty_123/connect',
        {
          headers: { Upgrade: 'websocket' },
        },
      ),
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
