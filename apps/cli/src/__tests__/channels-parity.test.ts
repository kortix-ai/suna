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

function startServer(opts: { emailEnabled?: boolean } = {}): string {
  const emailEnabled = opts.emailEnabled ?? true;
  let botName: string | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json();
      calls.push({ method: req.method, path: url.pathname, query: url.search, body });
      const p = url.pathname.replace(`/v1/projects/${PROJECT}`, '');

      if (p === '' && req.method === 'GET') {
        return Response.json({
          project_id: PROJECT,
          name: 'Channels',
          metadata: botName ? { meet: { bot_name: botName } } : {},
        });
      }
      if (p === '/channels/teams/installation' && req.method === 'DELETE') {
        return Response.json({ status: 'disconnected' });
      }
      if (p === '/channels/email/mode' && req.method === 'GET') {
        return Response.json({
          provider: 'agentmail',
          enabled: emailEnabled,
          managed_available: true,
        });
      }
      if (p === '/channels/email/installation' && req.method === 'GET') {
        return Response.json(emailEnabled ? EMAIL_INSTALL : null);
      }
      if (p === '/channels/email/connect' && req.method === 'POST') {
        if (!emailEnabled) {
          return Response.json(
            { error: 'Email is not enabled for this project.', code: 'feature_disabled', feature: 'agentmail_email' },
            { status: 403 },
          );
        }
        return Response.json(EMAIL_INSTALL);
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
      if (p === '/channels/meet/name' && req.method === 'PUT') {
        botName = String((body as { name: string }).name).trim().slice(0, 80) || 'Kortix';
        return Response.json({ ok: true, bot_name: botName });
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

describe('kortix channels — email, bindings, voice, teams disconnect', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-channels-parity-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents email, bindings, bind and voice', async () => {
    const r = await runCli(['channels', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('email connect');
    expect(r.stdout).toContain('email policy');
    expect(r.stdout).toContain('bindings [ls]');
    expect(r.stdout).toContain('bind <bindingId>');
    expect(r.stdout).toContain('voice name <text>');
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

  test('the feature-flag 403 on email connect is surfaced verbatim', async () => {
    const config = writeConfig(startServer({ emailEnabled: false }));
    const r = await runCli(['channels', 'email', 'connect', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Email is not enabled for this project.');
  });

  test('bindings ls prints each channel with its effective agent/model/policy', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'bindings', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      { method: 'GET', path: `/v1/projects/${PROJECT}/channels/bindings`, query: '', body: null },
    ]);
    expect(r.stdout).toMatch(/bind_1\s+eng\s+slack\s+default \(project\)\s+auto \(platform\)\s+owner_approval/);
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
        '--model', 'glm-5.2',
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
      body: { agentName: 'reviewer', opencodeModel: 'glm-5.2', conversationPolicy: 'owner_only' },
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

  test('voice name writes the name and --show reads it back off the project row', async () => {
    const config = writeConfig(startServer());
    const before = await runCli(['channels', 'voice', 'name', '--show', '--project', PROJECT], config);
    expect(before.code).toBe(0);
    expect(before.stdout).toContain('Kortix (default)');

    const set = await runCli(
      ['channels', 'voice', 'name', 'Acme', 'Support', '--project', PROJECT],
      config,
    );
    expect(set.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: `/v1/projects/${PROJECT}/channels/meet/name`,
      query: '',
      body: { name: 'Acme Support' },
    });
    expect(set.stdout).toContain('Voice bot name → Acme Support');

    const after = await runCli(
      ['channels', 'voice', 'name', '--show', '--project', PROJECT, '--json'],
      config,
    );
    expect(JSON.parse(after.stdout)).toEqual({ bot_name: 'Acme Support', is_default: false });
  });

  test('an unknown email action exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['channels', 'email', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown email action "nope"');
  });
});
