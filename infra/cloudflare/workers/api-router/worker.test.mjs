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
  test('deploys the dev router from dev and verifies its commit and SCIM boundary', () => {
    const workflow = Bun.YAML.parse(readFileSync(new URL('../../../../.github/workflows/deploy-api-router-dev.yml', import.meta.url), 'utf8'));
    expect(workflow.on.push.branches).toEqual(['dev']);
    expect(workflow.on.push.paths).toContain('infra/cloudflare/workers/api-router/**');
    const job = workflow.jobs.deploy;
    expect(job.if).toBe("github.ref == 'refs/heads/dev'");
    expect(job['continue-on-error']).toBeUndefined();
    const commands = job.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('deploy --env dev');
    expect(commands).not.toContain('--env prod');
    expect(commands).not.toContain('--env staging');
    expect(commands).toContain('DEPLOYED_COMMIT:${GITHUB_SHA}');
    expect(commands).toContain('dev-api-kortix-router/settings');
    expect(commands).toContain('.text == $sha');
    expect(commands).toContain("-H 'User-Agent:'");
    expect(commands).toContain('[ "$status" = 401 ]');
    expect(commands).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });

  test('routes staging to its eu-west-2 stack in config and deployment metadata', () => {
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
    expect(stagingVars).toContain('ACTIVE_BACKEND = "eu-west-2"');
    expect(stagingVars).toContain('GATEWAY_ACTIVE_BACKEND = "eu-west-2"');
    expect(stagingVars).toContain('BACKEND_EU_WEST_2 = "https://staging-api-euw2.kortix.com"');
    for (const binding of [
      '{type:"plain_text", name:"ACTIVE_BACKEND", text:"eu-west-2"}',
      '{type:"plain_text", name:"BACKEND_EU_WEST_2", text:"https://staging-api-euw2.kortix.com"}',
      '{type:"plain_text", name:"GATEWAY_ACTIVE_BACKEND", text:"eu-west-2"}',
      '{type:"plain_text", name:"GATEWAY_BACKEND_EU_WEST_2", text:"https://gateway-staging-euw2.kortix.com"}',
    ]) {
      expect(deployWorkflow).toContain(binding);
    }
  });

  test('routes dev to its us-east-2 stack and keeps the us-west-2 origins as the undo', () => {
    const wrangler = readFileSync(
      new URL('./wrangler.toml', import.meta.url),
      'utf8',
    );
    const devVars = wrangler.match(
      /\[env\.dev\.vars\]([\s\S]*?)(?=\n\[env\.|\s*$)/,
    )?.[1];

    expect(devVars).toContain('ACTIVE_BACKEND = "us-east-2"');
    expect(devVars).toContain('GATEWAY_ACTIVE_BACKEND = "us-east-2"');
    expect(devVars).toContain('BACKEND_US_EAST_2 = "https://dev-api-use2.kortix.com"');
    expect(devVars).toContain('GATEWAY_BACKEND_US_EAST_2 = "https://gateway-dev-use2.kortix.com"');
    expect(devVars).toContain('BACKEND_ECS_FARGATE = "https://dev-api-ecs-fargate.kortix.com"');
    expect(devVars).toContain('GATEWAY_BACKEND_ECS_FARGATE = "https://gateway-dev-ecs-fargate.kortix.com"');
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
      new URL('../../../terraform/environments/staging-eu-west-2/main.tf', import.meta.url),
      'utf8',
    );
    const devTerraform = readFileSync(
      new URL('../../../terraform/environments/dev-us-east-2/main.tf', import.meta.url),
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
    // staging's floor is var.api_task_count (2 only while the old stack still
    // holds database connections), so read the variable's default.
    const stagingVariables = readFileSync(
      new URL('../../../terraform/environments/staging-eu-west-2/variables.tf', import.meta.url),
      'utf8',
    );
    expect(stagingApi).toMatch(/min_capacity\s*=\s*var\.api_task_count/);
    const stagingFloor = Number(
      stagingVariables.match(/variable "api_task_count"[\s\S]*?default\s*=\s*(\d+)/)?.[1],
    );
    expect(stagingFloor).toBeGreaterThanOrEqual(num(devApi, 'min_capacity'));

    // A Spot-only service with no on-demand base goes to zero tasks on one
    // reclaim, and the edge then reports that as MAINTENANCE_MODE.
    expect(stagingApi).toMatch(/fargate_base_on_demand\s*=\s*1/);
    expect(stagingTerraform).toMatch(
      /module "gateway"[\s\S]*?fargate_base_on_demand\s*=\s*1/,
    );
    // Without a NON-ZERO value the module never creates the
    // ALBRequestCountPerTarget policy (0 is its default and the module skips
    // it), and an I/O-bound gateway blocked on upstream models never moves
    // CPU or memory — so it would never scale at all.
    //
    // The number is deliberately NOT the API's 600: the gateway holds whole
    // request bodies in memory while it forwards them, so it saturates on
    // concurrency far earlier than the API does. Asserting 600 here only ever
    // passed by accident of regex ordering — the API's own 600 sits ABOVE the
    // gateway block, so this pattern could never match the gateway's value.
    const stagingGateway = stagingTerraform.match(/module "gateway"[\s\S]*?\n}\n/)?.[0];
    expect(stagingGateway).toBeDefined();
    const gatewayRequestsPerTarget = num(stagingGateway, 'requests_per_target_target');
    expect(gatewayRequestsPerTarget).toBeGreaterThan(0);
    // The gateway must be able to add replicas, not just sit at its floor.
    expect(num(stagingGateway, 'max_capacity')).toBeGreaterThan(
      num(stagingGateway, 'min_capacity'),
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
    expect(response.headers.get('X-Backend')).toBeNull();
    expect(response.headers.get('X-Backend-Service')).toBeNull();
  });

  test('strips backend-identifying headers supplied by an origin', async () => {
    globalThis.fetch = async () => new Response('ok', {
      headers: { 'X-Backend': 'internal', 'X-Backend-Service': 'internal' },
    });
    const response = await worker.fetch(new Request('https://api.kortix.com/v1/health'), env);
    expect(response.headers.get('X-Backend')).toBeNull();
    expect(response.headers.get('X-Backend-Service')).toBeNull();
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
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

  test.each(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])(
    'relays Entra SCIM %s without a User-Agent and preserves authentication',
    async (method) => {
      let proxiedRequest;
      globalThis.fetch = async (request) => {
        proxiedRequest = request;
        return Response.json({ schemas: [], detail: 'Invalid SCIM token' }, { status: 401 });
      };
      const response = await worker.fetch(
        new Request('https://dev-api.kortix.com/scim/v2/accounts/00000000-0000-4000-a000-000000000000/Users', {
          method,
          headers: { Authorization: 'Bearer invalid-test-token' },
          ...(method === 'GET' ? {} : { body: '{"Operations":[]}' }),
        }),
        env,
      );
      expect(proxiedRequest.headers.get('User-Agent')).toBe('Kortix-SCIM-Relay/1.0');
      expect(proxiedRequest.headers.get('Authorization')).toBe('Bearer invalid-test-token');
      expect(response.status).toBe(401);
      if (method !== 'GET') expect(await proxiedRequest.text()).toBe('{"Operations":[]}');
    },
  );

  test.each(['Users', 'Groups/test-group', 'ServiceProviderConfig', 'ResourceTypes/User', 'Schemas/urn:ietf:params:scim:schemas:core:2.0:User'])(
    'normalizes an empty SCIM User-Agent for %s',
    async (resource) => {
      let proxiedRequest;
      globalThis.fetch = async (request) => {
        proxiedRequest = request;
        return Response.json({});
      };
      await worker.fetch(new Request(`https://dev-api.kortix.com/scim/v2/accounts/00000000-0000-4000-a000-000000000000/${resource}`, {
        headers: { 'User-Agent': '' },
      }), env);
      expect(proxiedRequest.headers.get('User-Agent')).toBe('Kortix-SCIM-Relay/1.0');
    },
  );

  test.each([
    ['https://dev-api.kortix.com/scim/v2/accounts/00000000-0000-4000-a000-000000000000/Users', 'Entra/1.0', 'Entra/1.0'],
    ['https://gateway-dev.kortix.com/scim/v2/accounts/00000000-0000-4000-a000-000000000000/Users', null, null],
    ['https://dev-api.kortix.com/scim/v2/accounts/not-an-account/Users', null, null],
    ['https://dev-api.kortix.com/scim/v2/accounts/00000000-0000-4000-a000-000000000000/Unknown', null, null],
  ])('preserves sender headers and SCIM routing boundaries: %s', async (url, userAgent, expected) => {
    let proxiedRequest;
    globalThis.fetch = async (request) => {
      proxiedRequest = request;
      return Response.json({});
    };
    await worker.fetch(new Request(url, {
      headers: userAgent ? { 'User-Agent': userAgent } : {},
    }), env);
    expect(proxiedRequest.headers.get('User-Agent')).toBe(expected);
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

  // A GET or HEAD that arrives carrying a body must still reach the origin.
  // The Workers runtime throws inside `new Request` when a GET/HEAD carries a
  // body, the origin request is built outside the try/catch, and Cloudflare
  // answers the client with its bare "error code: 1101" 500 before the origin
  // ever ran (reproduced on workerd: GET/HEAD with a body returned 500
  // "TypeError: Request with a GET or HEAD method cannot have a body." at the
  // origin-request construction). GET and HEAD bodies have no defined
  // semantics, so the origin request never carries one: the body is dropped
  // and the content-length that framed it goes with it. Bun's Request
  // constructor does not enforce the GET/HEAD rule the Workers runtime does,
  // so the incoming request is modeled by shadowing `body` on a real Request.
  test.each(['GET', 'HEAD'])('a %s with a body reaches the origin without a body', async (method) => {
    const incoming = new Request('https://api.kortix.com/v1/projects', { method });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('unexpected'));
        controller.close();
      },
    });
    Object.defineProperty(incoming, 'body', { get: () => stream });
    incoming.headers.set('content-length', '9');

    let proxiedRequest;
    globalThis.fetch = async (request) => {
      proxiedRequest = request;
      return Response.json({ ok: true });
    };

    const response = await worker.fetch(incoming, env);

    expect(response.status).toBe(200);
    expect(proxiedRequest.method).toBe(method);
    expect(proxiedRequest.body).toBeNull();
    expect(proxiedRequest.headers.get('content-length')).toBeNull();
    expect(await proxiedRequest.text()).toBe('');
  });

  test('a POST body is forwarded to the origin unchanged', async () => {
    let proxiedRequest;
    globalThis.fetch = async (request) => {
      proxiedRequest = request;
      return Response.json({ ok: true });
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/projects', {
        method: 'POST',
        headers: { 'content-length': '7' },
        body: 'payload',
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(proxiedRequest.headers.get('content-length')).toBe('7');
    expect(await proxiedRequest.text()).toBe('payload');
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
    expect(response.headers.get('X-Backend')).toBeNull();
    expect(response.headers.get('X-Backend-Service')).toBeNull();
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
    expect(apiResponse.headers.get('X-Backend')).toBeNull();
    expect(gatewayResponse.headers.get('X-Backend')).toBeNull();
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
    // Blocking maintenance only ever refuses writes, so a read never waits on
    // the maintenance state: it goes straight to the origin.
    expect(fetchedUrls).toEqual(['https://api-fargate.kortix.com/v1/accounts']);
  });

  // ── Edge preflight cache ─────────────────────────────────────────────────
  // The browser caches a CORS preflight per URL, so every new project, session
  // or query string paid a full origin round trip (0.24–1.0 s measured) before
  // the real request. The API's CORS policy is path-independent, so the edge
  // keeps the API's own answer per (host, Origin, method, headers).
  function fakeEdgeCache() {
    const store = new Map();
    return {
      store,
      default: {
        async match(key) {
          const hit = store.get(fetchUrl(key));
          return hit ? hit.clone() : undefined;
        },
        async put(key, response) {
          store.set(fetchUrl(key), response.clone());
        },
      },
    };
  }

  function preflight(path, origin = 'https://kortix.com', headers = 'authorization,content-type') {
    return new Request(`https://api.kortix.com${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': headers,
      },
    });
  }

  function corsOrigin() {
    const calls = [];
    globalThis.fetch = async (request) => {
      calls.push(`${request.method} ${fetchUrl(request)}`);
      const origin = request.headers.get('Origin');
      const allowed = origin === 'https://kortix.com';
      return new Response(null, {
        status: 204,
        headers: allowed
          ? {
              'Access-Control-Allow-Origin': origin,
              'Access-Control-Allow-Credentials': 'true',
              'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type,Authorization',
              'Access-Control-Max-Age': '600',
            }
          : {},
      });
    };
    return calls;
  }

  test('answers a repeat preflight for any path from the edge cache', async () => {
    const edge = fakeEdgeCache();
    globalThis.caches = edge;
    const calls = corsOrigin();
    try {
      const first = await worker.fetch(preflight('/v1/projects/a/detail'), env);
      const second = await worker.fetch(preflight('/v1/projects/b/sessions?limit=5'), env);
      const reordered = await worker.fetch(preflight('/v1/accounts', 'https://kortix.com', 'content-type, Authorization'), env);

      expect(calls).toEqual(['OPTIONS https://api-fargate.kortix.com/v1/projects/a/detail']);
      for (const response of [first, second, reordered]) {
        expect(response.status).toBe(204);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://kortix.com');
        expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      }
      expect(second.headers.get('X-Kortix-Preflight')).toBe('edge');
    } finally {
      delete globalThis.caches;
    }
  });

  test('never caches a preflight the origin refused, and keys by Origin', async () => {
    const edge = fakeEdgeCache();
    globalThis.caches = edge;
    const calls = corsOrigin();
    try {
      await worker.fetch(preflight('/v1/accounts', 'https://evil.example'), env);
      const again = await worker.fetch(preflight('/v1/accounts', 'https://evil.example'), env);
      await worker.fetch(preflight('/v1/accounts', 'https://kortix.com'), env);

      expect(calls).toHaveLength(3);
      expect(again.headers.get('Access-Control-Allow-Origin')).toBeNull();
    } finally {
      delete globalThis.caches;
    }
  });

  test('passes preflights through untouched where no edge cache exists', async () => {
    const calls = corsOrigin();

    await worker.fetch(preflight('/v1/accounts'), env);
    await worker.fetch(preflight('/v1/accounts'), env);

    expect(calls).toHaveLength(2);
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

  // ── Origin errors pass through verbatim ───────────────────────────────────
  // Until 2026-08-24 every origin 502/503/504 was replaced by a synthetic
  // "Service maintenance" 503. That hid a gateway content-encoding bug on dev
  // for days ("Kortix is temporarily unavailable" while the gateway logged
  // 200s). The origin's status, body and headers are now the contract.
  function originFails(status, headers = {}) {
    globalThis.fetch = async () =>
      new Response('origin body', { status, headers });
  }

  test('an origin 503 passes through with its own status, body and request id', async () => {
    originFails(503, { 'x-request-id': 'req-abc123', 'content-type': 'application/json' });

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts'),
      env,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('origin body');
    expect(response.headers.get('x-request-id')).toBe('req-abc123');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('X-Maintenance-Mode')).toBeNull();
    expect(response.headers.get('X-Backend')).toBeNull();
    expect(response.headers.get('X-Backend-Service')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('an origin 502 and 504 pass through unchanged, on the gateway host too', async () => {
    for (const status of [502, 504]) {
      originFails(status);
      const response = await worker.fetch(
        new Request('https://gateway.kortix.com/v1/chat/completions', { method: 'POST' }),
        env,
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('origin body');
      expect(response.headers.get('X-Backend-Service')).toBeNull();
      expect(response.headers.get('X-Maintenance-Mode')).toBeNull();
    }
  });

  test('an unreachable origin is a named 503 origin_unreachable, retryable, with no request id', async () => {
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts'),
      env,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Origin-Status')).toBe('fetch-error');
    // tests/src/core/client.ts isKe2eTransientGatewayResponse classifies a
    // 502/503/504 as transient only when x-request-id is ABSENT and retry-after
    // is present. An unreachable origin must keep matching that.
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('X-Maintenance-Mode')).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: 'origin_unreachable', type: 'origin_unreachable' },
      code: 'origin_unreachable',
      retry_after_seconds: 30,
    });
    expect(body.error.message).toBe('Kortix API origin is unreachable: connection refused');
  });

  test('a healthy origin response carries no origin-status header', async () => {
    globalThis.fetch = async () => Response.json({ ok: true }, { status: 200 });

    const response = await worker.fetch(
      new Request('https://api.kortix.com/v1/accounts'),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Origin-Status')).toBeNull();
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

  describe('/internal edge gate', () => {
    const gated = { ...env, INTERNAL_EDGE_KEY: 'edge-key-1' };
    const call = (path, headers = {}, e = gated, host = 'api.kortix.com') => {
      const seen = [];
      globalThis.fetch = async (input) => {
        seen.push(input.headers.get('x-kortix-internal-edge-key'));
        return new Response('{"principal":null}', { status: 200 });
      };
      return worker
        .fetch(new Request(`https://${host}${path}`, { method: 'POST', headers }), e)
        .then((response) => ({ response, seen }));
    };

    test('public caller without the key gets 404 and never reaches the origin', async () => {
      const { response, seen } = await call('/internal/gateway/authenticate');
      expect(response.status).toBe(404);
      expect(seen).toEqual([]);
      expect((await call('/internal/gateway/authenticate', { 'x-kortix-internal-edge-key': 'nope' })).response.status).toBe(404);
    });

    test('gateway with the key is forwarded and the key is stripped', async () => {
      const { response, seen } = await call('/internal/gateway/authenticate', { 'x-kortix-internal-edge-key': 'edge-key-1' });
      expect(response.status).toBe(200);
      expect(seen).toEqual([null]);
    });

    test('non-internal paths and an unset key are unaffected', async () => {
      expect((await call('/v1/health')).response.status).toBe(200);
      expect((await call('/internal/gateway/authenticate', {}, env)).response.status).toBe(200);
    });
  });
});
