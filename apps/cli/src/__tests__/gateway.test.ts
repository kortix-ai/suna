import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const SANDBOX_ENV_OVERRIDES = [
  'KORTIX_API_URL',
  'KORTIX_TOKEN',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_TOKEN',
  'BASH_ENV',
] as const;

const PROJECT = 'gw_proj';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: Array<{ method: string; path: string; body?: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_gw',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

// What the mock's GET /keys reports as gateway_url. null = the API serves the
// gateway itself (no LLM_GATEWAY_BASE_URL) — the case the CLI must resolve.
let keysGatewayUrl: string | null = 'https://gw.test/v1/llm';

// A routing policy the mock mutates on PUT so a set→get round-trip is observable.
let routingProject = {
  defaultModel: null as string | null,
  visionModel: null as string | null,
  defaultFallback: null as { models: string[]; fallbackOn: string } | null,
  rules: [] as unknown[],
};

function routingDoc() {
  return {
    version: 1,
    project: routingProject,
    effective: {
      defaultModel: routingProject.defaultModel ?? 'glm-5.3-flash',
      defaultModelSource: routingProject.defaultModel ? 'project' : 'platform',
      visionModel: routingProject.visionModel ?? 'claude-sonnet-4.6',
      defaultFallback: routingProject.defaultFallback ?? { models: [], fallbackOn: 'transient' },
    },
    capabilities: { write: true },
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const entry: { method: string; path: string; body?: unknown } = {
        method: req.method,
        path: `${url.pathname}${url.search}`,
      };
      if (!['GET', 'HEAD'].includes(req.method)) {
        const text = await req.text();
        if (text) entry.body = JSON.parse(text);
      }
      requests.push(entry);
      const base = `/v1/projects/${PROJECT}/gateway`;

      if (url.pathname === `${base}/routing-policy`) {
        if (req.method === 'PUT') routingProject = entry.body as typeof routingProject;
        if (req.method === 'DELETE')
          routingProject = {
            defaultModel: null,
            visionModel: null,
            defaultFallback: null,
            rules: [],
          };
        return Response.json(routingDoc());
      }
      if (url.pathname === `${base}/budgets` && req.method === 'GET') {
        return Response.json({
          project_spend: { requests: 4, cost: 280 },
          budgets: [
            {
              budget_id: 'budget_1',
              scope: 'project',
              subject_user_id: null,
              limit_usd: 20,
              period: 'day',
              action: 'block',
              spent_usd: 15,
              period_start: '2026-10-13T00:00:00.000Z',
              resets_at: '2026-10-14T00:00:00.000Z',
            },
          ],
          members: [],
        });
      }
      if (url.pathname === `${base}/budgets` && req.method === 'PUT') {
        return Response.json({ ok: true });
      }
      if (url.pathname === `${base}/keys` && req.method === 'GET') {
        return Response.json({ gateway_url: keysGatewayUrl, keys: [] });
      }
      if (url.pathname === `${base}/keys` && req.method === 'POST') {
        return Response.json({
          key_id: 'key_1',
          name: (entry.body as { name: string }).name,
          key_prefix: 'kortix_gw_ab',
          secret_key: 'kortix_gw_secretshownonce',
          gateway_url: keysGatewayUrl,
        });
      }
      if (url.pathname === `${base}/overview`) {
        return Response.json({
          window_days: 30,
          requests: 10,
          errors: 1,
          total_cost: 0.5,
          estimated_usage_value: 0.02,
          priced_requests: 9,
          unpriced_requests: 1,
          input_tokens: 100,
          output_tokens: 50,
        });
      }
      if (url.pathname === `${base}/breakdown`) {
        return Response.json({
          window_days: 30,
          models: [
            {
              model: 'openai/gpt-5.5',
              provider: 'openai',
              requests: 7,
              errors: 0,
              cost: 0.42,
              tokens: 120,
            },
          ],
        });
      }
      if (url.pathname === `${base}/logs`) {
        return Response.json({
          logs: [
            {
              request_id: 'req_1',
              requested_model: 'openai/gpt-5.5',
              status: 200,
              ok: true,
              latency_ms: 900,
            },
          ],
          next_offset: null,
        });
      }
      if (url.pathname === `${base}/logs/req_1`) {
        return Response.json({
          log_id: '11111111-1111-4111-8111-111111111111',
          request_id: 'req_1',
        });
      }
      if (url.pathname === `${base}/playground` && req.method === 'POST') {
        const models = (entry.body as { models: string[] }).models;
        return Response.json({
          gateway_url: keysGatewayUrl,
          results: models.map((m) => ({
            model: m,
            ok: true,
            latency_ms: 100,
            output: 'pong',
            input_tokens: 3,
            output_tokens: 1,
          })),
        });
      }
      return Response.json({ error: 'not found', path: url.pathname }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of SANDBOX_ENV_OVERRIDES) delete env[key];
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix gateway command', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-gw-'));
    requests = [];
    routingProject = { defaultModel: null, visionModel: null, defaultFallback: null, rules: [] };
    keysGatewayUrl = 'https://gw.test/v1/llm';
    process.env = { ...ORIGINAL_ENV };
    for (const key of SANDBOX_ENV_OVERRIDES) delete process.env[key];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('routing get: hits routing-policy and emits the effective policy as JSON', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway', 'routing', '--json', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).effective.defaultModel).toBe('glm-5.3-flash');
    expect(requests).toEqual([
      { method: 'GET', path: `/v1/projects/${PROJECT}/gateway/routing-policy` },
    ]);
  }, 15_000);

  test('routing set: reads current then PUTs a merged body (one field changed, rest preserved)', async () => {
    const cfg = writeConfig(startServer());
    routingProject = {
      defaultModel: null,
      visionModel: 'claude-sonnet-4.6',
      defaultFallback: null,
      rules: [],
    };
    const r = await runCli(
      ['gateway', 'routing', 'set', '--default-model', 'openai/gpt-5.5', '--project', PROJECT],
      cfg,
    );
    expect(r.code).toBe(0);
    const put = requests.find((q) => q.method === 'PUT');
    expect(put?.path).toBe(`/v1/projects/${PROJECT}/gateway/routing-policy`);
    // The unrelated visionModel is preserved; only defaultModel changes.
    expect(put?.body).toMatchObject({
      defaultModel: 'openai/gpt-5.5',
      visionModel: 'claude-sonnet-4.6',
    });
  }, 15_000);

  test('routing set: the merged body keeps the stored per-model generation settings', async () => {
    const cfg = writeConfig(startServer());
    const generation = { 'openai/gpt-4.1': { temperature: 0.3 } };
    routingProject = {
      defaultModel: null,
      visionModel: null,
      defaultFallback: null,
      rules: [],
      modelGenerationConfig: generation,
    } as typeof routingProject;
    const r = await runCli(
      ['gateway', 'routing', 'set', '--default-model', 'openai/gpt-5.5', '--project', PROJECT],
      cfg,
    );
    expect(r.code).toBe(0);
    const put = requests.find((q) => q.method === 'PUT');
    expect(put?.body).toMatchObject({ defaultModel: 'openai/gpt-5.5', modelGenerationConfig: generation });
  }, 15_000);

  test('budget ls: each budget shows the spend of its own period and its reset, not the month', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway', 'budget', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('PROJECT SPEND (this month)  28,000 credits · 4 req');
    expect(r.stdout).toContain('1,500 of 2,000 credits/day project (block) resets 2026-10-14T00:00:00.000Z budget_1');
    const raw = await runCli(['gateway', 'budget', '--json', '--project', PROJECT], cfg);
    expect(JSON.parse(raw.stdout).budgets[0].limit_usd).toBe(20);
  }, 15_000);

  test('budget set: PUTs limit/scope with the expected shape', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(
      ['gateway', 'budget', 'set', '--limit', '25', '--period', 'month', '--project', PROJECT],
      cfg,
    );
    expect(r.code).toBe(0);
    const put = requests.find((q) => q.method === 'PUT');
    // --limit is USD (the API field); the confirmation names both units.
    expect(put?.body).toMatchObject({ scope: 'project', limit_usd: 25, period: 'month' });
    expect(r.stdout).toContain('budget set: 2,500 credits ($25.00)/month (project)');
  }, 15_000);

  test('keys new: POSTs the name and surfaces the one-time secret', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway', 'keys', 'new', 'ci-key', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kortix_gw_secretshownonce');
    expect(requests.find((q) => q.method === 'POST')?.body).toMatchObject({ name: 'ci-key' });
  }, 15_000);

  test('keys ls --json: an API-reported gateway_url passes through', async () => {
    const apiBase = startServer();
    const cfg = writeConfig(apiBase);
    const r = await runCli(['gateway', 'keys', 'ls', '--json', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).gateway_url).toBe('https://gw.test/v1/llm');
  }, 15_000);

  test("keys ls --json: no API-reported URL falls back to the API host's own gateway mount (regression KRTX-1750)", async () => {
    keysGatewayUrl = null;
    const apiBase = startServer();
    const cfg = writeConfig(apiBase);
    const r = await runCli(['gateway', 'keys', 'ls', '--json', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.gateway_url).not.toBeNull();
    expect(out.gateway_url).toBe(`${apiBase}/v1/llm`);
  }, 15_000);

  test('keys ls: prints the resolved gateway URL, never the string "null" (regression KRTX-1750)', async () => {
    keysGatewayUrl = null;
    const apiBase = startServer();
    const cfg = writeConfig(apiBase);
    const r = await runCli(['gateway', 'keys', 'ls', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Gateway URL: ${apiBase}/v1/llm`);
    expect(r.stdout).not.toContain('Gateway URL: null');
  }, 15_000);

  test('keys new: prints the full gateway URL the key works against (regression KRTX-1750)', async () => {
    const apiBase = startServer();
    const cfg = writeConfig(apiBase);
    const r = await runCli(['gateway', 'keys', 'new', 'ci-key', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    // The complete OpenAI-compatible endpoint, not an unnamed "the gateway URL".
    expect(r.stdout).toContain('https://gw.test/v1/llm/v1/chat/completions');
  }, 15_000);

  test('keys new --json: includes the gateway_url the new key works against', async () => {
    keysGatewayUrl = null;
    const apiBase = startServer();
    const cfg = writeConfig(apiBase);
    const r = await runCli(
      ['gateway', 'keys', 'new', 'ci-key', '--json', '--project', PROJECT],
      cfg,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).gateway_url).toBe(`${apiBase}/v1/llm`);
  }, 15_000);

  test('usage: aggregates overview + breakdown', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(
      ['gateway', 'usage', '--json', '--days', '30', '--project', PROJECT],
      cfg,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.overview.requests).toBe(10);
    expect(out.breakdown.models[0].model).toBe('openai/gpt-5.5');
    expect(requests.map((q) => q.path).sort()).toEqual([
      `/v1/projects/${PROJECT}/gateway/breakdown?days=30`,
      `/v1/projects/${PROJECT}/gateway/overview?days=30`,
    ]);
    expect(out.overview.total_cost).toBe(0.5);
    const human = await runCli(['gateway', 'usage', '--project', PROJECT], cfg);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('LLM estimated usage value (not a bill): 2 credits · priced 9; unpriced 1');
    expect(human.stdout).toContain('10 req · 1 err · 50 credits · 100/50 tok');
    expect(human.stdout).toMatch(/openai\/gpt-5\.5\s+7 req  42 credits/);
  }, 15_000);

  test('logs --limit N: the value is a query param, never mistaken for a logId (regression)', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway', 'logs', '--limit', '3', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    // The list endpoint with ?limit=3 — NOT /logs/3 (which 400s "Invalid log id").
    expect(requests).toEqual([
      { method: 'GET', path: `/v1/projects/${PROJECT}/gateway/logs?limit=3` },
    ]);
  }, 15_000);

  test('logs --failed: filters to ok=false', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway', 'logs', '--failed', '--json', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(requests[0].path).toBe(`/v1/projects/${PROJECT}/gateway/logs?ok=false`);
  }, 15_000);

  test('logs accepts the request_id printed by the list command', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway', 'logs', 'req_1', '--project', PROJECT], cfg);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).request_id).toBe('req_1');
    expect(requests).toEqual([
      { method: 'GET', path: `/v1/projects/${PROJECT}/gateway/logs/req_1` },
    ]);
  }, 15_000);

  test('test: POSTs prompt + models to the playground', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(
      [
        'gateway',
        'test',
        'openai/gpt-5.5',
        'openai/gpt-4o',
        '--prompt',
        'ping',
        '--json',
        '--project',
        PROJECT,
      ],
      cfg,
    );
    expect(r.code).toBe(0);
    const post = requests.find((q) => q.method === 'POST');
    expect(post?.path).toBe(`/v1/projects/${PROJECT}/gateway/playground`);
    expect(post?.body).toMatchObject({
      prompt: 'ping',
      models: ['openai/gpt-5.5', 'openai/gpt-4o'],
    });
    expect(JSON.parse(r.stdout).results).toHaveLength(2);
  }, 15_000);

  test.each([true, false])('test: exposes the configured gateway URL (json=%s)', async (json) => {
    const cfg = writeConfig(startServer());
    const r = await runCli(
      ['gateway', 'test', 'openai/gpt-5.5', '--project', PROJECT, ...(json ? ['--json'] : [])],
      cfg,
    );
    expect(r.code).toBe(0);
    if (json) {
      expect(JSON.parse(r.stdout).gateway_url).toBe('https://gw.test/v1/llm');
      expect(JSON.parse(r.stdout).results[0].output).toBe('pong');
    } else {
      expect(r.stdout).toContain('Gateway URL: https://gw.test/v1/llm');
      expect(r.stdout).toContain('pong');
    }
  });

  test('test: resolves a missing gateway URL against the selected host', async () => {
    keysGatewayUrl = null;
    const apiBase = startServer();
    const cfg = writeConfig(apiBase);
    const r = await runCli(
      ['gateway', 'test', 'openai/gpt-5.5', '--json', '--project', PROJECT], cfg,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).gateway_url).toBe(`${apiBase}/v1/llm`);
  });

  test('routing reset: DELETEs the policy', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway', 'routing', 'reset', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(
      requests.some(
        (q) => q.method === 'DELETE' && q.path === `/v1/projects/${PROJECT}/gateway/routing-policy`,
      ),
    ).toBe(true);
  }, 15_000);

  test('bare `gateway` prints help and exits non-zero', async () => {
    const cfg = writeConfig(startServer());
    const r = await runCli(['gateway'], cfg);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('kortix gateway <subcommand>');
  }, 15_000);
});
