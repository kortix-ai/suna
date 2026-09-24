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
/** The accounts GET .../connectors/:slug/accounts returns, default first. */
let connectorAccounts: Array<Record<string, unknown>> = [];

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
      if (url.pathname === `${ex}/connectors/gmail/connect` && req.method === 'POST') {
        return Response.json({
          provider: 'composio',
          app: 'gmail',
          connectUrl: 'https://connect.composio.test/auth_1',
          connected: false,
          isNoAuth: false,
          sessionId: 'trs_1',
          connectionId: '11111111-1111-4111-8111-111111111111',
          requestId: 'auth_1',
        });
      }
      if (url.pathname === `${ex}/connectors/gmail/accounts` && req.method === 'GET') {
        return Response.json({
          connector: 'gmail',
          accounts: connectorAccounts,
        });
      }
      if (
        url.pathname.startsWith(`/v1/projects/${PROJECT}/connections/`) &&
        url.pathname.endsWith('/default') &&
        req.method === 'PUT'
      ) {
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
      if (url.pathname === `${ex}/connect/toolkits`) {
        return Response.json({
          items: [{ slug: 'slack', name: 'Slack', description: 'Chat', categories: ['comms'], connection: { isActive: false } }],
          cursor: null,
          totalPages: 1,
        });
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
    connectorAccounts = [
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        label: 'Sales inbox',
        owner_type: 'project',
        is_default: true,
        connected_as: 'sales@example.test',
      },
      {
        connection_id: '22222222-2222-4222-8222-222222222222',
        label: 'user@example.test',
        owner_type: 'member',
        is_default: false,
      },
    ];
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

  // `authorization_strategy` was a connector-level mode that made shared and
  // private accounts mutually exclusive — and left a `user` connector with no
  // connect flow at all (2026-09-16). Ownership is a property of each ACCOUNT
  // now, so the command survives for scripts but must touch nothing.
  test('owner is a deprecated no-op: exit 0, no API call, points at the accounts model', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'owner', 'gmail', 'user', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.stdout).toContain('ownership is per account now');
    expect(r.stdout).toContain('kortix connectors connect gmail --owner me|project');
    expect(r.stdout).toContain('kortix connectors accounts gmail');
  });

  test('owner no longer needs a project|user argument at all', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'owner', 'gmail', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
  });

  // The owner of the account a connect link creates. It is sent ONLY when
  // asked for: the connect body is `.strict()` server-side, so a CLI that
  // always sent `owner` would 400 against an API deployed before the field.
  test('connect defaults to the caller and sends no owner field', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'connect', 'gmail', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/connectors/projects/${PROJECT}/connectors/gmail/connect`,
      body: {},
    });
    expect(JSON.parse(r.stdout)).toMatchObject({
      slug: 'gmail',
      owner: 'me',
      url: 'https://connect.composio.test/auth_1',
    });
  });

  test('connect --owner project asks for a shared account', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['connectors', 'connect', 'gmail', '--owner', 'project', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/connectors/projects/${PROJECT}/connectors/gmail/connect`,
      body: { owner: 'project' },
    });
    expect(r.stdout).toContain('shared with every project member');
  });

  test('connect --owner rejects anything but me|project before any request', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['connectors', 'connect', 'gmail', '--owner', 'everyone', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--owner must be me or project');
    expect(calls).toEqual([]);
  });

  test('accounts tables what --account accepts, shared/private, default first', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'accounts', 'gmail', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'GET',
      path: `/v1/connectors/projects/${PROJECT}/connectors/gmail/accounts`,
      body: null,
    });
    const lines = r.stdout.split('\n').map((line) => line.trim());
    expect(
      lines.some((line) => /^LABEL\s+CONNECTED AS\s+OWNER\s+DEFAULT\s+CONNECTION ID$/.test(line)),
    ).toBe(true);
    // Order is the API's: the default account first. CONNECTED AS names the
    // authorized identity, or `—` when the server does not know it.
    const rows = lines.filter((line) => /^(Sales inbox|user@example\.test)\s/.test(line));
    expect(rows[0]).toMatch(
      /^Sales inbox\s+sales@example\.test\s+shared\s+yes\s+11111111-1111-4111-8111-111111111111\s+\(pinned default\)$/,
    );
    expect(rows[1]).toMatch(
      /^user@example\.test\s+—\s+private\s+no\s+22222222-2222-4222-8222-222222222222$/,
    );
    expect(r.stdout).toContain('2 accounts');
    // A ready-to-copy example per account, plus the two selector words.
    expect(r.stdout).toContain('kortix connectors call gmail <action> --account "Sales inbox"');
    expect(r.stdout).toContain(
      'kortix connectors call gmail <action> --account "user@example.test"',
    );
    expect(r.stdout).toContain('kortix connectors call gmail <action> --account me');
    expect(r.stdout).toContain('kortix connectors call gmail <action> --account project');
    // A default IS pinned here (Sales inbox), so no account_required warning.
    expect(r.stdout).not.toContain('No default pinned');
  });

  test('accounts warns when several accounts exist and none is pinned', async () => {
    connectorAccounts = [
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        label: 'Sales inbox',
        owner_type: 'project',
        is_default: false,
      },
      {
        connection_id: '22222222-2222-4222-8222-222222222222',
        label: 'user@example.test',
        owner_type: 'member',
        is_default: false,
      },
    ];
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'accounts', 'gmail', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No default pinned');
    expect(r.stdout).toContain('account_required');
    expect(r.stdout).toContain('kortix connectors accounts gmail --default <label>');
  });

  test('accounts --default pins one account by label, resolved through the accounts list', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['connectors', 'accounts', 'gmail', '--project', PROJECT, '--default', 'user@example.test'],
      config,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Pinned');
    expect(r.stdout).toContain('user@example.test');
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: `/v1/projects/${PROJECT}/connections/22222222-2222-4222-8222-222222222222/default`,
      body: {},
    });
  });

  test('accounts --default reports an unknown label clearly and makes no write', async () => {
    const config = writeConfig(startServer());
    const before = calls.length;
    const r = await runCli(
      ['connectors', 'accounts', 'gmail', '--project', PROJECT, '--default', 'nope@example.test'],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No account "nope@example.test"');
    // Only the accounts GET happened — no PUT default was attempted.
    expect(calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
  });

  test('accounts --json emits the payload agents parse', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'accounts', 'gmail', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      connector: 'gmail',
      accounts: [
        {
          connection_id: '11111111-1111-4111-8111-111111111111',
          label: 'Sales inbox',
          owner_type: 'project',
          is_default: true,
          connected_as: 'sales@example.test',
        },
        {
          connection_id: '22222222-2222-4222-8222-222222222222',
          label: 'user@example.test',
          owner_type: 'member',
          is_default: false,
        },
      ],
    });
  });

  test('accounts with nothing connected names the remedy, in both faces', async () => {
    connectorAccounts = [];
    const config = writeConfig(startServer());
    const human = await runCli(['connectors', 'accounts', 'gmail', '--project', PROJECT], config);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('No connected accounts.');
    expect(human.stdout).toContain('kortix connectors connect gmail --owner me');
    expect(human.stdout).toContain('kortix connectors connect gmail --owner project');

    const json = await runCli(['connectors', 'accounts', 'gmail', '--project', PROJECT, '--json'], config);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      connector: 'gmail',
      accounts: [],
      note: `Nothing is connected to "gmail" yet. Run 'kortix connectors connect gmail --owner me'.`,
    });
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

  // `apps` searches Composio by default — those are the slugs `add --provider
  // composio --app` accepts. The Pipedream catalogue is legacy rollback-only.
  test('apps forwards --category to the Composio toolkit catalogue', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'apps', 'sl', '--category', 'comms', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v1/connectors/projects/${PROJECT}/connect/toolkits?q=sl&category=comms`);
    expect(r.stdout).toContain('slack');
  });

  test('apps --pipedream forwards --category to the legacy catalogue', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['connectors', 'apps', 'sl', '--category', 'comms', '--pipedream', '--project', PROJECT], config);
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
