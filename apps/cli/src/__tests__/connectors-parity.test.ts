import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_connectors';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
let projectPolicies: Array<Record<string, unknown>> = [];
let defaultMode = 'risk';
let discoverEnabled = true;

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_connectors',
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

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const ex = `/v1/connectors/projects/${PROJECT}`;

      if (url.pathname === `${ex}/policies` && req.method === 'GET') {
        return Response.json({ policies: projectPolicies, defaultMode });
      }
      if (url.pathname === `${ex}/policies` && req.method === 'PUT') {
        projectPolicies = (body as any).policies;
        defaultMode = (body as any).defaultMode;
        return Response.json({ ok: true });
      }
      if (url.pathname === `${ex}/connectors/gmail/sensitive` && req.method === 'PUT') {
        return Response.json({ ok: true });
      }
      if (url.pathname === `${ex}/connectors/gmail/authorization-strategy` && req.method === 'PUT') {
        return Response.json({ ok: true });
      }
      if (url.pathname === `${ex}/discover/connectors/detail` && req.method === 'GET') {
        return Response.json({
          item: { id: 'stripe', kind: 'api', slug: 'stripe', name: 'Stripe', description: 'Payments', url: null, categories: ['finance'] },
          variants: [
            { id: 'stripe-openapi', kind: 'openapi', name: 'Stripe REST', url: 'https://stripe.test/openapi.json', docs: null, description: null, transports: [], requiresAuth: true, command: null, connector: null },
          ],
        });
      }
      if (url.pathname === `${ex}/discover/connectors` && req.method === 'GET') {
        if (!discoverEnabled) {
          return Response.json(
            {
              error: 'Connector discovery is not enabled for this project. Enable it in Settings → Feature flags.',
              code: 'feature_disabled',
              feature: 'connectors_api_discover',
            },
            { status: 403 },
          );
        }
        return Response.json({
          items: [
            { id: 'stripe', kind: 'api', slug: 'stripe', name: 'Stripe', description: 'Payments', url: null, categories: ['finance'] },
            { id: 'linear', kind: 'api', slug: 'linear', name: 'Linear', description: 'Issues', url: null, categories: ['dev'] },
          ],
          total: 2,
          nextCursor: 'cur_2',
          hasMore: true,
        });
      }
      if (url.pathname === `${ex}/connectors/desk/config` && req.method === 'GET') {
        return Response.json({
          slug: 'desk',
          name: 'Desk',
          provider: 'computer',
          tunnelIds: ['11111111-1111-4111-8111-111111111111'],
          auth: { type: 'none', in: 'header', name: null, prefix: null },
        });
      }
      if (url.pathname === `${ex}/connectors/gmail/config` && req.method === 'GET') {
        return Response.json({ slug: 'gmail', name: 'Gmail', provider: 'pipedream', auth: { type: 'none' } });
      }
      if (url.pathname === `${ex}/connectors` && req.method === 'POST') {
        return Response.json({ ok: true, sync: { synced: 1, errors: [] } });
      }
      // ── OAuth 2.1 device flow ────────────────────────────────────────────
      if (url.pathname === `/v1/projects/${PROJECT}/connectors/gmail/oauth2/connection` && req.method === 'POST') {
        return Response.json({ connection_id: 'conn_1' });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/connections/conn_1/oauth2/discover-resource`) {
        return Response.json({
          discovery: {
            resource_url: 'https://mail.test/mcp',
            requires_authorization: true,
            resource_name: 'Mail',
            authorization_server: 'https://auth.test',
            registration_endpoint: 'https://auth.test/register',
            metadata: {
              authorization_url: 'https://auth.test/authorize',
              token_url: 'https://auth.test/token',
              device_authorization_url: 'https://auth.test/device',
            },
            scopes: ['mail.read'],
            warnings: [],
          },
        });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/connections/conn_1/oauth2/register`) {
        return Response.json({ application: { client_id: 'cli_1' } });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/connections/conn_1/oauth2/device` && req.method === 'POST') {
        return Response.json({
          session_id: 'sess_dev',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://auth.test/activate',
          verification_uri_complete: 'https://auth.test/activate?code=WDJB-MJHT',
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          interval_seconds: 1,
        });
      }
      if (url.pathname === `/v1/projects/${PROJECT}/connections/conn_1/oauth2/device/sess_dev`) {
        return Response.json({ status: 'active', scopes: ['mail.read'] });
      }
      if (url.pathname === `${ex}/pipedream/apps` && req.method === 'GET') {
        return Response.json({ apps: [{ slug: 'slack', name: 'Slack', description: 'Chat', categories: ['comms'] }], hasMore: false });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix connectors — capability-page parity', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-connectors-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    projectPolicies = [{ match: 'send_*', action: 'require_approval' }];
    defaultMode = 'risk';
    discoverEnabled = true;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents every new subcommand', async () => {
    const r = await runCli(['connectors', '--help']);
    expect(r.code).toBe(0);
    for (const fragment of ['sensitive <slug> on|off', 'owner <slug> project|user', 'catalog show <id>', 'machines <slug>', 'policy add <match> <action>', 'policy rm <match>', '--device']) {
      expect(r.stdout).toContain(fragment);
    }
  });

  test('sensitive on|off PUTs the boolean', async () => {
    const config = writeConfig(startServer());
    const on = await runCli(['connectors', 'sensitive', 'gmail', 'on', '--project', PROJECT], config);
    expect(on.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: `/v1/connectors/projects/${PROJECT}/connectors/gmail/sensitive`,
      body: { sensitive: true },
    });
    expect(on.stdout).toContain('every call needs approval');

    calls = [];
    const off = await runCli(['connectors', 'sensitive', 'gmail', 'off', '--project', PROJECT], config);
    expect(off.code).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ sensitive: false });
  });

  test('sensitive without on/off exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'sensitive', 'gmail', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass on or off');
  });

  test('owner PUTs authorization_strategy — the field the route validates', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'owner', 'gmail', 'user', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: `/v1/connectors/projects/${PROJECT}/connectors/gmail/authorization-strategy`,
      body: { authorization_strategy: 'user' },
    });
    expect(r.stdout).toContain('each member authorizes their own connection');
  });

  test('owner rejects anything but project|user', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'owner', 'gmail', 'account', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass project or user');
  });

  test('catalog lists records and forwards q + cursor', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'catalog', 'pay', '--cursor', 'cur_1', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v1/connectors/projects/${PROJECT}/discover/connectors?q=pay&cursor=cur_1`);
    expect(r.stdout).toContain('stripe');
    expect(r.stdout).toContain('--cursor cur_2');
  });

  test('catalog show reads the detail route by id', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'catalog', 'show', 'stripe', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v1/connectors/projects/${PROJECT}/discover/connectors/detail?id=stripe`);
    expect(r.stdout).toContain('stripe-openapi');
    expect(r.stdout).toContain('(auth)');
  });

  test('catalog surfaces the connectors_api_discover gate verbatim', async () => {
    const config = writeConfig(startServer());
    discoverEnabled = false;
    const r = await runCli(['connectors', 'catalog', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Connector discovery is not enabled for this project');
  });

  test('machines --show reads the config without writing', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'machines', 'desk', '--show', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(r.stdout).toContain('11111111-1111-4111-8111-111111111111');
  });

  test('machines --add/--rm read-merge-write the whole tunnel_ids list', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['connectors', 'machines', 'desk', '--add', '22222222-2222-4222-8222-222222222222', '--rm', '11111111-1111-4111-8111-111111111111', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/connectors/projects/${PROJECT}/connectors`,
      body: {
        slug: 'desk',
        name: 'Desk',
        provider: 'computer',
        tunnel_ids: ['22222222-2222-4222-8222-222222222222'],
      },
    });
  });

  test('machines refuses to empty the list — the route would 400', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'machines', 'desk', '--rm', '11111111-1111-4111-8111-111111111111', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('at least one machine');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('machines on a non-computer connector says so', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'machines', 'gmail', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is a pipedream connector');
  });

  test('policy show prints the default mode and every rule with its conditions', async () => {
    const config = writeConfig(startServer());
    projectPolicies = [{ match: 'send_*', action: 'block', conditions: [{ arg: 'to', match: '*@corp.com', negate: true }] }];
    const r = await runCli(['connectors', 'policy', 'show', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('default mode: risk');
    expect(r.stdout).toContain('send_* → block when to!=*@corp.com');
  });

  test('policy add read-merge-writes the project rules and maps k=v conditions', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['connectors', 'policy', 'add', 'delete_*', 'block', '--condition', 'scope=prod', '--condition', 'actor!=bot', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe(`/v1/connectors/projects/${PROJECT}/policies`);
    expect(put.body).toEqual({
      policies: [
        { match: 'send_*', action: 'require_approval' },
        {
          match: 'delete_*',
          action: 'block',
          conditions: [
            { arg: 'scope', match: 'prod' },
            { arg: 'actor', match: 'bot', negate: true },
          ],
        },
      ],
      defaultMode: 'risk',
    });
    expect(r.stdout).toContain('delete_* → block when scope=prod, actor!=bot');
  });

  test('policy add rejects a malformed --condition before any write', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'add', 'x', 'block', '--condition', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--condition must look like arg=value');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  test('policy rm drops one rule and keeps the default mode', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'rm', 'send_*', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ policies: [], defaultMode: 'risk' });
  });

  test('policy rm of an unknown match exits 1 without writing', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'rm', 'never_*', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No project rule matching "never_*"');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  test('policy set --default WITHOUT --apply stays local — no HTTP call at all', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'set', '--default', 'allow_all', '--project', PROJECT], config);
    // No kortix.yaml in the temp dir, so the local edit fails — the point is
    // that it never reached the network, exactly as it did before this slice.
    expect(r.code).not.toBe(0);
    expect(calls).toEqual([]);
  });

  test('policy set --default --apply PUTs the mode and preserves the rules', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'set', '--default', 'allow_all', '--apply', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      policies: [{ match: 'send_*', action: 'require_approval' }],
      defaultMode: 'allow_all',
    });
    expect(r.stdout).toContain('Project default mode → allow_all');
  });

  test('policy set --apply rejects an invalid default mode', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'set', '--default', 'nope', '--apply', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--default risk|allow_all');
  });

  test('apps forwards --category to the Pipedream catalogue', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'apps', 'sl', '--category', 'comms', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v1/connectors/projects/${PROJECT}/pipedream/apps?q=sl&category=comms`);
    expect(r.stdout).toContain('slack');
  });

  test('authorize --device registers, prints the code, and polls to active', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'authorize', 'gmail', '--device', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.path)).toEqual([
      `/v1/projects/${PROJECT}/connectors/gmail/oauth2/connection`,
      `/v1/projects/${PROJECT}/connections/conn_1/oauth2/discover-resource`,
      `/v1/projects/${PROJECT}/connections/conn_1/oauth2/register`,
      `/v1/projects/${PROJECT}/connections/conn_1/oauth2/device`,
      `/v1/projects/${PROJECT}/connections/conn_1/oauth2/device/sess_dev`,
    ]);
    expect(calls.at(-2)!.body).toEqual({ scopes: ['mail.read'] });
    expect(r.stdout).toContain('WDJB-MJHT');
    expect(r.stdout).toContain('https://auth.test/activate?code=WDJB-MJHT');
    expect(r.stdout).toContain('Authorized');
  });

  test('authorize --device --json stops at the code instead of polling', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'authorize', 'gmail', '--device', '--json', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { user_code: string; session_id: string };
    expect(parsed.user_code).toBe('WDJB-MJHT');
    expect(parsed.session_id).toBe('sess_dev');
    expect(calls.some((c) => c.path.endsWith('/device/sess_dev'))).toBe(false);
  });

  test('connector-scoped policy verbs still work unchanged', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'policy', 'gmail', 'ls', '--project', PROJECT], config);
    // The fake API has no per-connector policies route, so this 404s — what
    // matters is that the slug form still routes to the connector path.
    expect(calls.at(-1)!.path).toBe(`/v1/connectors/projects/${PROJECT}/connectors/gmail/policies`);
    expect(r.code).toBe(1);
  });
});
