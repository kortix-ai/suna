import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_channels';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_channels',
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

const EMAIL_INSTALL = {
  connectionSlug: 'kortix_email',
  inboxId: 'ibx_1',
  email: 'support@acme.kortix.email',
  displayName: 'Acme Support',
  webhookId: 'wh_1',
  senderPolicy: {
    mode: 'restricted',
    allowedEmails: ['bob@x.io'],
    allowedDomains: ['acme.com'],
    allowedRegex: null,
  },
  installedAt: '2026-01-01T00:00:00.000Z',
  connection_id: 'conn_1',
};

const BINDING = {
  bindingId: 'bind_1',
  platform: 'slack',
  workspaceId: 'T1',
  channelId: 'C1',
  channelName: 'eng',
  channelType: 'public',
  agentName: null,
  opencodeModel: null,
  conversationPolicy: 'owner_approval',
  installedAt: '2026-01-01T00:00:00.000Z',
  effectiveAgent: { agent: 'default', source: 'project' },
  effectiveModel: { model: null, source: 'platform' },
};

const INBOX = {
  connection_id: 'conn_1',
  inbox_id: 'inb_1',
  email: 'support@kortixmail.com',
  display_name: 'Support',
  label: 'support@kortixmail.com',
  owner_type: 'project',
  owner_id: null,
  is_default: true,
  managed: true,
  created_by_kortix: true,
  sender_policy: { mode: 'allow_all', allowed_emails: [], allowed_domains: [], allowed_regex: null },
  agent_name: null,
  created_at: '2026-10-24T00:00:00.000Z',
};
const PRIVATE_INBOX = { ...INBOX, connection_id: 'conn_2', inbox_id: 'inb_2', email: 'me@kortixmail.com', label: 'me@kortixmail.com', owner_type: 'member', owner_id: 'u1', is_default: true };

function startServer(
  opts: { emailEnabled?: boolean; failTeams?: boolean; connected?: boolean; managedEmail?: boolean } = {},
): string {
  const emailEnabled = opts.emailEnabled ?? true;
  const managedEmail = opts.managedEmail ?? true;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json();
      calls.push({ method: req.method, path: url.pathname, query: url.search, body });
      const p = url.pathname.replace(`/v1/projects/${PROJECT}`, '');

      if (p === '' && req.method === 'GET') {
        return Response.json({ project_id: PROJECT, name: 'Channels', metadata: {} });
      }
      if ((p === '/channels/slack/installation' || p === '/channels/teams/installation') && req.method === 'GET') {
        if (opts.failTeams && p.includes('/teams/')) {
          return Response.json({ error: 'Teams unavailable' }, { status: 503 });
        }
        return Response.json(opts.connected ? { installedAt: '2026-01-01' } : null);
      }
      if (p === '/channels/teams/installation' && req.method === 'DELETE') {
        return Response.json({ status: 'disconnected' });
      }
      if (p === '/channels/email/mode' && req.method === 'GET') {
        return Response.json({
          provider: 'resend',
          enabled: emailEnabled,
          managed_available: managedEmail,
        });
      }
      if (p === '/channels/email/installation' && req.method === 'GET') {
        return Response.json(emailEnabled ? EMAIL_INSTALL : null);
      }
      if (p === '/channels/email/connect' && req.method === 'POST') {
        if (!emailEnabled) {
          return Response.json(
            { error: 'Email is not enabled for this project.', code: 'feature_disabled', feature: 'email_channel' },
            { status: 403 },
          );
        }
        return Response.json(EMAIL_INSTALL);
      }
      if (p === '/channels/email/inboxes' && req.method === 'GET') {
        return Response.json({ inboxes: [INBOX, PRIVATE_INBOX] });
      }
      if (p === '/channels/email/inboxes' && req.method === 'POST') {
        const b = body as { share?: string; username?: string };
        return Response.json(b.share === 'me' ? { ...PRIVATE_INBOX, email: `${b.username}@kortixmail.com` } : INBOX, { status: 201 });
      }
      if (p === '/channels/email/inboxes/conn_2' && req.method === 'DELETE') {
        return Response.json({ status: 'deleted', inbox_deleted: true });
      }
      if (p === '/channels/email/inboxes/conn_1' && req.method === 'PATCH') {
        const b = body as { sender_policy: { allowedDomains: string[] } };
        return Response.json({
          ...INBOX,
          sender_policy: { mode: 'restricted', allowed_emails: [], allowed_domains: b.sender_policy.allowedDomains, allowed_regex: null },
        });
      }
      if (p === '/connections/conn_2/default' && req.method === 'PUT') {
        return Response.json({ ok: true });
      }
      if (p === '/channels/email/domains/add' && req.method === 'POST') {
        const b = body as { domain: string };
        return Response.json({
          domain: {
            domain_id: 'dom_1',
            domain: b.domain,
            status: 'PENDING',
            verified: false,
            records: [{ type: 'MX', name: b.domain, value: 'inbound-smtp.us-east-1.amazonaws.com', status: 'MISSING', priority: 10 }],
          },
          setup: null,
        });
      }
      if (p === '/channels/email/installation' && req.method === 'DELETE') {
        return Response.json({ status: 'disconnected' });
      }
      if (p === '/channels/email/installation' && req.method === 'PATCH') {
        const b = body as { sender_policy: typeof EMAIL_INSTALL.senderPolicy };
        return Response.json({ ...EMAIL_INSTALL, senderPolicy: b.sender_policy });
      }
      if (p === '/channels/bindings' && req.method === 'GET') {
        return Response.json({ projectDefaultAgent: 'default', bindings: [BINDING] });
      }
      if (p === '/channels/bindings/bind_1' && req.method === 'PATCH') {
        const b = body as Record<string, unknown>;
        return Response.json({
          ...BINDING,
          agentName: (b.agentName as string | null) ?? null,
          opencodeModel: (b.opencodeModel as string | null) ?? null,
          conversationPolicy: (b.conversationPolicy as string) ?? BINDING.conversationPolicy,
          effectiveAgent: b.agentName
            ? { agent: b.agentName as string, source: 'explicit' }
            : { agent: 'default', source: 'project' },
          effectiveModel: b.opencodeModel
            ? { model: b.opencodeModel as string, source: 'explicit' }
            : { model: null, source: 'platform' },
        });
      }
      if (p === '/channels/bindings/bind_missing' && req.method === 'PATCH') {
        return Response.json({ error: 'Binding not found' }, { status: 404 });
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
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'BASH_ENV',
  ]) {
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

describe('kortix channels — email, bindings, teams disconnect', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-channels-parity-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
  });

  test('bare channels and status list Slack, Teams and disabled Email together', async () => {
    const config = writeConfig(startServer({ emailEnabled: false }));
    for (const sub of [[], ['status']]) {
      const result = await runCli(['channels', ...sub, '--project', PROJECT], config);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/slack\s+not connected/i);
      expect(result.stdout).toMatch(/teams\s+not connected/i);
      expect(result.stdout).toMatch(/email\s+off/i);
    }
  });

  test('combined JSON reports all states; explicit platform preserves its JSON shape', async () => {
    const config = writeConfig(startServer());
    const result = await runCli(['channels', 'status', '--json', '--project', PROJECT], config);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.slack).toEqual({ connected: false, installation: null });
    expect(value.teams).toEqual({ connected: false, installation: null });
    expect(value.email.connected).toBe(true);
    expect(value.email.mode.enabled).toBe(true);
    for (const platform of ['slack', 'teams']) {
      calls = [];
      const filtered = await runCli([
        'channels', 'status', '--platform', platform, '--json', '--project', PROJECT,
      ], config);
      expect(filtered.code).toBe(0);
      expect(JSON.parse(filtered.stdout)).toEqual({ connected: false, installation: null });
      expect(calls.filter((call) => call.path.includes('/channels/')).map((call) => call.path))
        .toEqual([`/v1/projects/${PROJECT}/channels/${platform}/installation`]);
    }
  });

  test('connected chat channels render connected and a failed read never claims disconnected', async () => {
    let config = writeConfig(startServer({ connected: true }));
    const connected = await runCli(['channels', '--project', PROJECT], config);
    expect(connected.code).toBe(0);
    expect(connected.stdout).toMatch(/slack\s+connected/);
    expect(connected.stdout).toMatch(/teams\s+connected/);
    expect(connected.stdout).toMatch(/email\s+connected/);
    server?.stop(true);
    config = writeConfig(startServer({ failTeams: true }));
    const failed = await runCli(['channels', '--project', PROJECT], config);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('Teams unavailable');
    expect(failed.stdout).not.toContain('not connected');
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents email, bindings and bind', async () => {
    const r = await runCli(['channels', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('email connect');
    expect(r.stdout).toContain('email policy');
    expect(r.stdout).toContain('bindings [ls]');
    expect(r.stdout).toContain('bind <bindingId>');
    expect(r.stdout).not.toContain('voice');
    expect(r.stdout).toContain('project.connector.write');
  });

  test('disconnect --platform teams DELETEs the Teams installation', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['channels', 'disconnect', '--platform', 'teams', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'DELETE',
        path: `/v1/projects/${PROJECT}/channels/teams/installation`,
        query: '',
        body: null,
      },
    ]);
    expect(r.stdout).toContain('Disconnected');
  });

  test('email status reads mode + installation and prints the sender policy', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'email', 'status', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('support@acme.kortix.email');
    expect(r.stdout).toContain('restricted — bob@x.io · @acme.com');
    expect(calls.map((c) => `${c.method} ${c.path}${c.query}`).sort()).toEqual([
      `GET /v1/projects/${PROJECT}/channels/email/installation?connector_slug=kortix_email`,
      `GET /v1/projects/${PROJECT}/channels/email/mode`,
    ]);

    const j = await runCli(['channels', 'email', 'status', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(j.stdout).connected).toBe(true);
  });

  test('email connect POSTs the exact body, routing --allow by shape', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      [
        'channels', 'email', 'connect',
        '--username', 'support',
        '--domain', 'acme.kortix.email',
        '--display-name', 'Acme Support',
        '--allow', '@acme.com',
        '--allow', 'bob@x.io',
        '--allow', 'partner.io',
        '--project', PROJECT,
      ],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      // No --api-key: the CLI first checks that this server offers managed inboxes.
      { method: 'GET', path: `/v1/projects/${PROJECT}/channels/email/mode`, query: '', body: null },
      {
        method: 'POST',
        path: `/v1/projects/${PROJECT}/channels/email/connect`,
        query: '',
        body: {
          connector_slug: 'kortix_email',
          display_name: 'Acme Support',
          username: 'support',
          domain: 'acme.kortix.email',
          sender_policy: {
            mode: 'restricted',
            allowedEmails: ['bob@x.io'],
            allowedDomains: ['acme.com', 'partner.io'],
            allowedRegex: null,
          },
        },
      },
    ]);
    expect(r.stdout).toContain('support@acme.kortix.email');
  });

  test('email connect without --api-key, where Kortix-managed email is off, asks for your Resend key', async () => {
    const config = writeConfig(startServer({ managedEmail: false }));
    const r = await runCli(['channels', 'email', 'connect', '--username', 'support', '--project', PROJECT], config);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--api-key <re_');
    expect(r.stderr).toContain('https://resend.com/api-keys');
    expect(calls.some((c) => c.path.endsWith('/channels/email/connect'))).toBe(false);
  });

  test('email connect --api-key goes straight to connect with the key in the body', async () => {
    const config = writeConfig(startServer({ managedEmail: false }));
    const r = await runCli(
      ['channels', 'email', 'connect', '--api-key', 're_secret', '--domain', 'mail.acme.io', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /v1/projects/${PROJECT}/channels/email/connect`]);
    expect((calls[0]?.body as { api_key?: string }).api_key).toBe('re_secret');
  });

  test('email domains add POSTs the key in the body and prints the DNS records to set', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['channels', 'email', 'domains', 'add', 'mail.acme.io', '--api-key', 're_secret', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/v1/projects/${PROJECT}/channels/email/domains/add`,
        query: '',
        body: { api_key: 're_secret', domain: 'mail.acme.io' },
      },
    ]);
    expect(r.stdout).toContain('mail.acme.io');
    expect(r.stdout).toContain('inbound-smtp.us-east-1.amazonaws.com');
    expect(r.stdout).toContain('domains verify dom_1');
  });

  test('email connect refuses --inbox-id without --email before any request', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['channels', 'email', 'connect', '--inbox-id', 'ibx_9', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs BOTH --inbox-id and --email');
    expect(calls).toEqual([]);
  });

  test('email inboxes lists every inbox with its owner, kind and default', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'email', 'inboxes', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('support@kortixmail.com');
    expect(r.stdout).toContain('project · Kortix managed');
    expect(r.stdout).toContain('me@kortixmail.com');
    expect(r.stdout).toContain('only you');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: `/v1/projects/${PROJECT}/channels/email/inboxes` });
  });

  test('email inboxes add posts share, the name and the sender policy; the key stays in the body', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['channels', 'email', 'inboxes', 'add', '--username', 'help', '--share', 'me', '--allow', '@acme.com', '--json', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe(`/v1/projects/${PROJECT}/channels/email/inboxes`);
    expect(post.body).toEqual({
      share: 'me',
      username: 'help',
      sender_policy: { mode: 'restricted', allowedEmails: [], allowedDomains: ['acme.com'], allowedRegex: null },
    });
    expect(JSON.parse(r.stdout).email).toBe('help@kortixmail.com');
  });

  test('email inboxes add refuses an unknown --share before any request', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'email', 'inboxes', 'add', '--share', 'team', '--project', PROJECT], config);
    expect(r.code).not.toBe(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('email inboxes rm, default and policy name an inbox by its address', async () => {
    const config = writeConfig(startServer());
    const rm = await runCli(['channels', 'email', 'inboxes', 'rm', 'me@kortixmail.com', '--project', PROJECT], config);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain('deleted on Resend');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/v1/projects/${PROJECT}/channels/email/inboxes/conn_2` });

    const def = await runCli(['channels', 'email', 'inboxes', 'default', 'me@kortixmail.com', '--project', PROJECT], config);
    expect(def.code).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: `/v1/projects/${PROJECT}/connections/conn_2/default` });

    const pol = await runCli(['channels', 'email', 'inboxes', 'policy', 'support@kortixmail.com', '--allow', '@acme.com', '--project', PROJECT], config);
    expect(pol.code).toBe(0);
    expect(pol.stdout).toContain('@acme.com');
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: `/v1/projects/${PROJECT}/channels/email/inboxes/conn_1` });

    const missing = await runCli(['channels', 'email', 'inboxes', 'rm', 'nobody@kortixmail.com', '--project', PROJECT], config);
    expect(missing.code).not.toBe(0);
  });

  test('email disconnect passes connector_slug on the query string', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['channels', 'email', 'disconnect', '--connector', 'support_email', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'DELETE',
      path: `/v1/projects/${PROJECT}/channels/email/installation`,
      query: '?connector_slug=support_email',
      body: null,
    });
  });

  test('email policy PATCHes the whole policy; --allow-all clears it', async () => {
    const config = writeConfig(startServer());
    const restricted = await runCli(
      ['channels', 'email', 'policy', '--allow', '@acme.com', '--project', PROJECT],
      config,
    );
    expect(restricted.code).toBe(0);
    expect(calls.at(-1)?.body).toEqual({
      connector_slug: 'kortix_email',
      sender_policy: {
        mode: 'restricted',
        allowedEmails: [],
        allowedDomains: ['acme.com'],
        allowedRegex: null,
      },
    });

    const open = await runCli(
      ['channels', 'email', 'policy', '--allow-all', '--project', PROJECT],
      config,
    );
    expect(open.code).toBe(0);
    expect(calls.at(-1)?.body).toEqual({
      connector_slug: 'kortix_email',
      sender_policy: { mode: 'allow_all', allowedEmails: [], allowedDomains: [], allowedRegex: null },
    });
    expect(open.stdout).toContain('anyone');
  });

  test('email policy with nothing to set exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'email', 'policy', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--allow');
    expect(calls).toEqual([]);
  });

  test('email connect with the email_channel flag off names the command that turns it on', async () => {
    const config = writeConfig(startServer({ emailEnabled: false }));
    const r = await runCli(['channels', 'email', 'connect', '--api-key', 're_secret', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kortix projects features enable email_channel');
  });

  test('email status with the flag off says so and how to turn it on', async () => {
    const config = writeConfig(startServer({ emailEnabled: false }));
    const r = await runCli(['channels', 'email', 'status', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('email_channel feature flag is off');
  });

  test('bindings ls prints each channel with its effective agent/model/policy', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'bindings', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      { method: 'GET', path: `/v1/projects/${PROJECT}/channels/bindings`, query: '', body: null },
    ]);
    // A Slack channel reads `#eng`, as the Channels page shows it.
    expect(r.stdout).toMatch(/bind_1\s+#eng\s+slack\s+default \(project\)\s+auto \(platform\)\s+owner_approval/);
    expect(r.stdout).toContain('project default agent: default');

    const j = await runCli(['channels', 'bindings', 'ls', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(j.stdout).bindings[0].bindingId).toBe('bind_1');
  });

  test('bind sends only the fields the caller named; --no-agent/--no-model send null', async () => {
    const config = writeConfig(startServer());
    const set = await runCli(
      [
        'channels', 'bind', 'bind_1',
        '--agent', 'reviewer',
        '--model', 'glm-5.3-flash',
        '--policy', 'owner_only',
        '--project', PROJECT,
      ],
      config,
    );
    expect(set.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      path: `/v1/projects/${PROJECT}/channels/bindings/bind_1`,
      query: '',
      body: { agentName: 'reviewer', opencodeModel: 'glm-5.3-flash', conversationPolicy: 'owner_only' },
    });
    expect(set.stdout).toContain('agent   reviewer (explicit)');

    const reset = await runCli(
      ['channels', 'bind', 'bind_1', '--no-agent', '--no-model', '--project', PROJECT],
      config,
    );
    expect(reset.code).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ agentName: null, opencodeModel: null });
  });

  test('bind rejects an unknown policy and an empty patch without a request', async () => {
    const config = writeConfig(startServer());
    const bad = await runCli(
      ['channels', 'bind', 'bind_1', '--policy', 'anything', '--project', PROJECT],
      config,
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('owner_approval, owner_only, project_open');

    const empty = await runCli(['channels', 'bind', 'bind_1', '--project', PROJECT], config);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('at least one of --agent');

    const noId = await runCli(['channels', 'bind', '--agent', 'x', '--project', PROJECT], config);
    expect(noId.code).toBe(2);
    expect(noId.stderr).toContain('Pass a binding id');
    expect(calls).toEqual([]);
  });

  test('bind surfaces a 404 from the API', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['channels', 'bind', 'bind_missing', '--agent', 'reviewer', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Binding not found');
  });

  test('the removed voice subcommand is an unknown subcommand', async () => {
    const r = await runCli(['channels', 'voice', 'name', 'x', '--project', PROJECT]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "voice"');
  });

  test('an unknown email action exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'email', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown email action "nope"');
  });
});
