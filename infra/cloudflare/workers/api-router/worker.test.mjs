import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import worker from './worker.mjs';

const env = {
  ACTIVE_BACKEND: 'ecs-fargate',
  BACKEND_ECS_FARGATE: 'https://api-fargate.kortix.com',
  BACKEND_US_EAST_2: 'https://api-use2-shadow.kortix.com',
  // Gateway is deliberately on a DIFFERENT active backend than the API, to prove
  // the two services flip independently.
  GATEWAY_ACTIVE_BACKEND: 'ecs-fargate',
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
    expect(stagingVars).toContain('ACTIVE_BACKEND = "ecs-fargate"');
    expect(deployWorkflow).toContain(
      '{type:"plain_text", name:"ACTIVE_BACKEND", text:"ecs-fargate"}',
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

    // The select grew two more names (KORTIX_PUBLIC_VERSION,
    // NEXT_PUBLIC_KORTIX_VERSION) and now spans several lines, so pinning its
    // exact formatting went stale. Assert the two invariants instead.
    expect(ecsDeploy).toContain('.name != "KORTIX_VERSION"');
    expect(ecsDeploy).toContain('.name != "KORTIX_COMMIT"');
    expect(shadowWorkflow).toContain(
      'api_commit="$(jq -r \'.commit // empty\'',
    );
    expect(shadowWorkflow).toContain(
      '[ "$api_commit" != "$SOURCE_SHA" ] || [ "$gateway_commit" != "$SOURCE_SHA" ]',
    );
  });

  test('injects the environment secret as one JSON blob instead of per-key selectors', () => {
    const ecsDeploy = readFileSync(
      new URL('../../../scripts/ecs-deploy.sh', import.meta.url),
      'utf8',
    );
    const apiEntry = readFileSync(
      new URL('../../../../apps/api/src/index.ts', import.meta.url),
      'utf8',
    );
    const gatewayEntry = readFileSync(
      new URL('../../../../apps/llm-gateway/src/main.ts', import.meta.url),
      'utf8',
    );

    expect(ecsDeploy).toContain('name: "KORTIX_ENV_JSON"');
    expect(ecsDeploy).not.toContain('keys\n      | map({ name: .');
    expect(apiEntry.indexOf("import './environment-secret';")).toBeLessThan(
      apiEntry.indexOf("import './lib/sentry';"),
    );
    expect(gatewayEntry.indexOf("import './environment-secret';")).toBeLessThan(
      gatewayEntry.indexOf("import { config } from './config';"),
    );
  });

  test('requires an explicit database migration gate for live production ECS rolls', () => {
    const ecsDeploy = readFileSync(
      new URL('../../../scripts/ecs-deploy.sh', import.meta.url),
      'utf8',
    );
    const prodWorkflow = readFileSync(
      new URL('../../../../.github/workflows/deploy-prod.yml', import.meta.url),
      'utf8',
    );
    const shadowWorkflow = readFileSync(
      new URL(
        '../../../../.github/workflows/deploy-prod-us-east-2-shadow.yml',
        import.meta.url,
      ),
      'utf8',
    );

    expect(ecsDeploy).toContain('refusing live $ENV rollout without --database-migrated');
    // Three live prod rolls now carry the gate: api, gateway, and the web
    // service added at deploy-prod.yml:1238.
    expect(prodWorkflow.match(/--database-migrated/g)?.length).toBe(3);
    expect(shadowWorkflow.match(/--database-migrated/g)?.length).toBe(2);
  });

  test('keeps production API tasks at the incident-tested 4 GiB and three-task floor', () => {
    const prodTerraform = readFileSync(
      new URL('../../../terraform/environments/prod/main.tf', import.meta.url),
      'utf8',
    );
    const shadowTerraform = readFileSync(
      new URL('../../../terraform/environments/prod-us-east-2-shadow/main.tf', import.meta.url),
      'utf8',
    );

    expect(prodTerraform).toMatch(/module "api"[\s\S]*?task_memory\s*=\s*4096/);
    expect(prodTerraform).toMatch(/module "api"[\s\S]*?desired_count\s*=\s*3/);
    expect(prodTerraform).toMatch(/module "api"[\s\S]*?min_capacity\s*=\s*3/);
    expect(shadowTerraform).toMatch(/module "api"[\s\S]*?task_memory\s*=\s*4096/);
    expect(shadowTerraform).toMatch(/module "api"[\s\S]*?secrets_blob_arn\s*=\s*var\.secret_arn/);
  });

  test('keeps staging sized for the release gate, with an on-demand floor', () => {
    const stagingTerraform = readFileSync(
      new URL('../../../terraform/environments/staging/main.tf', import.meta.url),
      'utf8',
    );
    const devTerraform = readFileSync(
      new URL('../../../terraform/environments/dev/main.tf', import.meta.url),
      'utf8',
    );

    const stagingApi = stagingTerraform.match(
      /module "api"[\s\S]*?\n}\n/,
    )?.[0];
    const devApi = devTerraform.match(/module "api"[\s\S]*?\n}\n/)?.[0];
    expect(stagingApi).toBeDefined();
    expect(devApi).toBeDefined();

    // Staging absorbs the full release gate; dev absorbs nothing. Staging being
    // SMALLER than dev is what let the v0.13.0 gate knock it over.
    const num = (source, key) =>
      Number(source.match(new RegExp(`${key}\\s*=\\s*(\\d+)`))?.[1]);
    expect(num(stagingApi, 'task_cpu')).toBeGreaterThanOrEqual(
      num(devApi, 'task_cpu'),
    );
    expect(num(stagingApi, 'task_memory')).toBeGreaterThanOrEqual(
      num(devApi, 'task_memory'),
    );
    expect(num(stagingApi, 'min_capacity')).toBeGreaterThanOrEqual(
      num(devApi, 'min_capacity'),
    );

    // A Spot-only service with no on-demand base goes to zero tasks on one
    // reclaim, and the edge then reports that as MAINTENANCE_MODE.
    expect(stagingApi).toMatch(/fargate_base_on_demand\s*=\s*1/);
    expect(stagingTerraform).toMatch(
      /module "gateway"[\s\S]*?fargate_base_on_demand\s*=\s*1/,
    );
    // Without this the module never creates the request-count scaling policy.
    expect(stagingTerraform).toMatch(
      /module "gateway"[\s\S]*?requests_per_target_target\s*=\s*600/,
    );
  });

  test('the on-demand base is opt-in, so dev and prod strategies do not move', () => {
    const module = readFileSync(
      new URL('../../../terraform/modules/ecs-api/variables.tf', import.meta.url),
      'utf8',
    );
    const devTerraform = readFileSync(
      new URL('../../../terraform/environments/dev/main.tf', import.meta.url),
      'utf8',
    );
    const prodTerraform = readFileSync(
      new URL('../../../terraform/environments/prod/main.tf', import.meta.url),
      'utf8',
    );

    expect(module).toMatch(
      /variable "fargate_base_on_demand"[\s\S]*?default\s*=\s*0/,
    );
    expect(devTerraform).not.toContain('fargate_base_on_demand');
    expect(prodTerraform).not.toContain('fargate_base_on_demand');
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

    expect(proxiedUrl).toBe('https://api-fargate.kortix.com/v1/health/live');
    expect(response.status).toBe(200);
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000',
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Backend')).toBe('ecs-fargate');
    expect(response.headers.get('X-Backend-Service')).toBe('api');
  });

  test.each([
    '/v1/webhooks/projects/00000000-0000-4000-a000-000000000000/hook',
    '/v1/webhooks/slack',
    '/v1/billing/webhook/stripe',
    '/v1/billing/webhooks/stripe',
    '/v1/connectors/webhook/pipedream',
  ])('adds a relay User-Agent only when webhook ingress omits it: %s', async (path) => {
    let proxiedRequest;
    globalThis.fetch = async (request) => {
      proxiedRequest = request;
      return Response.json({ accepted: true });
    };

    const response = await worker.fetch(
      new Request(`https://api.kortix.com${path}`, {
        method: 'POST',
        body: '{"event":"test"}',
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(proxiedRequest.headers.get('User-Agent')).toBe(
      'Kortix-Webhook-Relay/1.0',
    );
    expect(await proxiedRequest.text()).toBe('{"event":"test"}');
  });

  test('preserves a webhook sender User-Agent', async () => {
    let proxiedUserAgent = '';
    globalThis.fetch = async (request) => {
      proxiedUserAgent = request.headers.get('User-Agent');
      return Response.json({ accepted: true });
    };

    await worker.fetch(
      new Request('https://api.kortix.com/v1/webhooks/slack', {
        method: 'POST',
        headers: { 'User-Agent': 'Slackbot 1.0' },
        body: '{}',
      }),
      env,
    );

    expect(proxiedUserAgent).toBe('Slackbot 1.0');
  });

  test('does not add User-Agent to non-webhook requests', async () => {
    let proxiedUserAgent;
    globalThis.fetch = async (request) => {
      proxiedUserAgent = request.headers.get('User-Agent');
      return Response.json({ accepted: true });
    };

    await worker.fetch(
      new Request('https://api.kortix.com/v1/projects', {
        method: 'POST',
        body: '{}',
      }),
      env,
    );

    expect(proxiedUserAgent).toBeNull();
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
        fetchUrl(request) === 'https://api-fargate.kortix.com/v1/system/maintenance'
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
      'https://api-fargate.kortix.com/v1/system/maintenance',
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
      'https://api-fargate.kortix.com/v1/system/maintenance',
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
        fetchUrl(request) === 'https://api-fargate.kortix.com/v1/system/maintenance'
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
      'https://api-fargate.kortix.com/v1/system/maintenance',
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
      error: { code: 'MAINTENANCE_MODE' },
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
      'https://api-fargate.kortix.com/v1/accounts',
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
      'https://api-fargate.kortix.com/v1/projects',
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

    expect(fetchedUrls).toEqual(['https://api-fargate.kortix.com/v1/accounts']);
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toMatchObject({
      error: { code: 'MAINTENANCE_MODE' },
      maintenance: { level: 'blocking' },
    });
  });

  // ── CI origin-status passthrough ───────────────────────────────────────────
  // The laundering above is correct for public traffic and actively harmful for
  // the release gate: it turns "staging ran out of capacity" into "scheduled
  // maintenance". These pin the additive escape hatch — the public shape must
  // not move, and the passthrough must be reachable ONLY with the exact secret.
  const CI_SECRET = 'ci-passthrough-secret-value';
  const ciEnv = { ...env, CI_PASSTHROUGH_SECRET: CI_SECRET };

  function originFails(status, headers = {}) {
    globalThis.fetch = async () =>
      new Response('origin body', { status, headers });
  }

  test('without the CI header, an origin 503 is still laundered but names the origin status', async () => {
    originFails(503, { 'x-request-id': 'req-abc123' });

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts'),
      ciEnv,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'MAINTENANCE_MODE' } });
    expect(response.headers.get('X-Maintenance-Mode')).toBe('blocking');
    expect(response.headers.get('X-Origin-Status')).toBe('503');
    // The origin's own request id is restored, so an application 5xx is
    // distinguishable from an unreachable origin.
    expect(response.headers.get('X-Request-Id')).toBe('req-abc123');
  });

  test('with the correct CI header, the true origin status and body pass through', async () => {
    originFails(502, { 'x-request-id': 'req-xyz789' });

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts', {
        headers: { 'X-Kortix-CI-Passthrough': CI_SECRET },
      }),
      ciEnv,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('origin body');
    expect(response.headers.get('X-Origin-Status')).toBe('502');
    expect(response.headers.get('x-request-id')).toBe('req-xyz789');
    // No maintenance fiction is layered on top of a real failure.
    expect(response.headers.get('X-Maintenance-Mode')).toBeNull();
    expect(response.headers.get('X-Backend')).toBe('ecs-fargate');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('a wrong CI header gets the ordinary synthetic maintenance 503', async () => {
    originFails(504);

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts', {
        headers: { 'X-Kortix-CI-Passthrough': 'not-the-secret-value-at-all' },
      }),
      ciEnv,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'MAINTENANCE_MODE' } });
    expect(response.headers.get('X-Origin-Status')).toBe('504');
  });

  test('a prefix of the secret does not pass, and neither does an empty header', async () => {
    for (const presented of [CI_SECRET.slice(0, -1), `${CI_SECRET}x`, '']) {
      originFails(503);
      const response = await worker.fetch(
        new Request('https://api.kortix.com/v1/accounts', {
          headers: { 'X-Kortix-CI-Passthrough': presented },
        }),
        ciEnv,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'MAINTENANCE_MODE' },
      });
    }
  });

  test('an environment with no CI_PASSTHROUGH_SECRET binding cannot be opted out of laundering', async () => {
    originFails(503);

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts', {
        headers: { 'X-Kortix-CI-Passthrough': CI_SECRET },
      }),
      // `env` deliberately has no CI_PASSTHROUGH_SECRET.
      env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'MAINTENANCE_MODE' } });
  });

  test('an unreachable origin reports fetch-error and stays retryable for the test client', async () => {
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts', {
        headers: { 'X-Kortix-CI-Passthrough': CI_SECRET },
      }),
      ciEnv,
    );

    // There is no origin response to pass through, so CI gets the synthetic
    // 503 too — but it now says why.
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Origin-Status')).toBe('fetch-error');
    // tests/src/core/client.ts isKe2eTransientGatewayResponse classifies a
    // 502/503/504 as transient only when x-request-id is ABSENT and retry-after
    // is present. An unreachable origin must keep matching that.
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(response.headers.get('Retry-After')).toBe('30');
  });

  test('a healthy origin response carries no origin-status header', async () => {
    globalThis.fetch = async () => Response.json({ ok: true }, { status: 200 });

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts'),
      ciEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Origin-Status')).toBeNull();
  });

  test('the staging Worker deploy binds CI_PASSTHROUGH_SECRET from the repository secret', () => {
    const deployWorkflow = readFileSync(
      new URL(
        '../../../../.github/workflows/deploy-staging.yml',
        import.meta.url,
      ),
      'utf8',
    );

    expect(deployWorkflow).toContain(
      'CF_WORKER_CI_PASSTHROUGH_SECRET: ${{ secrets.CF_WORKER_CI_PASSTHROUGH_SECRET }}',
    );
    expect(deployWorkflow).toContain(
      '[{type:"secret_text", name:"CI_PASSTHROUGH_SECRET", text:$secret}]',
    );
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
      'https://api-fargate.kortix.com/v1/p/sbx_123/8000/kortix/pty/kpty_123/connect',
    );
    expect(proxiedUpgrade).toBe('websocket');
    expect(response).toBe(upgradeResponse);
    expect(response.webSocket).toBe(webSocket);
  });
});
