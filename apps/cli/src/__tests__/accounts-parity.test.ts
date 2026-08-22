// Parity coverage for the account-surface additions that live in EXISTING
// command files: `kortix roles edit` and `kortix audit webhooks`.
//
// Each block boots its own fake API and its own generated entry, so a failure
// names one command rather than one shared server.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runCommand,
  startFakeApi,
  writeConfig,
  writeRunner,
  type FakeApi,
} from './support/account-cli-harness.ts';

const ACCOUNT = 'account_1';
const ROLE_ID = '77777777-7777-4777-8777-777777777777';

let tmp: string;
let api: FakeApi | null = null;

function boot(handler: Parameters<typeof startFakeApi>[0]): string {
  api = startFakeApi(handler);
  return writeConfig(tmp, api.url, ACCOUNT);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-parity-'));
});

afterEach(() => {
  api?.stop();
  api = null;
  rmSync(tmp, { recursive: true, force: true });
});

// ── roles edit ─────────────────────────────────────────────────────────────

const ROLES = [
  {
    role_id: 'builtin:owner',
    key: 'owner',
    name: 'Owner',
    description: null,
    resource_type: 'account',
    is_system: true,
    account_id: null,
  },
  {
    role_id: ROLE_ID,
    key: 'support_agent',
    name: 'Support Agent',
    description: 'Reads sessions',
    resource_type: 'project',
    is_system: false,
    account_id: ACCOUNT,
  },
];

const roleRoutes: Parameters<typeof startFakeApi>[0] = (req, url, body) => {
  const p = url.pathname;
  if (p === `/v1/accounts/${ACCOUNT}/iam/roles` && req.method === 'GET') {
    return Response.json({ roles: ROLES });
  }
  if (p === `/v1/accounts/${ACCOUNT}/iam/roles/${ROLE_ID}` && req.method === 'PATCH') {
    const b = body as { name?: string; description?: string | null };
    return Response.json({
      ...ROLES[1],
      name: b.name ?? 'Support Agent',
      description: b.description === undefined ? 'Reads sessions' : b.description,
    });
  }
  return undefined;
};

describe('kortix roles edit', () => {
  let runner: string;
  beforeEach(() => {
    runner = writeRunner(tmp, 'roles.ts', 'runRoles');
  });

  test('--help documents edit and its flags', async () => {
    const h = await runCommand(runner, ['--help'], { cwd: tmp });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('edit <role> [--name <n>]');
    expect(h.stdout).toContain('--no-desc');
    expect(h.stdout).toContain('role.update');
  });

  test('edit resolves the role by key and PATCHes only the fields given', async () => {
    const config = boot(roleRoutes);
    const r = await runCommand(
      runner,
      ['edit', 'support_agent', '--name', 'Tier 1 Support'],
      { cwd: tmp, configFile: config },
    );
    expect(r.code).toBe(0);
    expect(api!.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      `GET /v1/accounts/${ACCOUNT}/iam/roles`,
      `PATCH /v1/accounts/${ACCOUNT}/iam/roles/${ROLE_ID}`,
    ]);
    expect(api!.requests[1]!.body).toEqual({ name: 'Tier 1 Support' });
    expect(r.stdout).toContain('Updated role support_agent — Tier 1 Support');

    const clear = await runCommand(runner, ['edit', 'support_agent', '--no-desc'], {
      cwd: tmp,
      configFile: config,
    });
    expect(clear.code).toBe(0);
    expect(api!.requests.at(-1)!.body).toEqual({ description: null });
  });

  test('editing a system role, or passing no fields, exits 2 without a PATCH', async () => {
    const config = boot(roleRoutes);
    const system = await runCommand(runner, ['edit', 'owner', '--name', 'Boss'], {
      cwd: tmp,
      configFile: config,
    });
    expect(system.code).toBe(2);
    expect(system.stderr).toContain('Built-in roles cannot be edited');

    const nothing = await runCommand(runner, ['edit', 'support_agent'], {
      cwd: tmp,
      configFile: config,
    });
    expect(nothing.code).toBe(2);
    expect(nothing.stderr).toContain('Pass --name, --desc or --no-desc');

    const noRef = await runCommand(runner, ['edit'], { cwd: tmp, configFile: config });
    expect(noRef.code).toBe(2);

    expect(api!.requests.every((q) => q.method === 'GET')).toBe(true);
  });
});

// ── audit webhooks ─────────────────────────────────────────────────────────

const WEBHOOKS_BASE = `/v1/accounts/${ACCOUNT}/audit/webhooks`;

const auditRoutes: Parameters<typeof startFakeApi>[0] = (req, url, body) => {
  const p = url.pathname;
  if (p === WEBHOOKS_BASE && req.method === 'GET') {
    return Response.json({
      webhooks: [
        {
          webhook_id: 'wh_1',
          name: 'splunk',
          url: 'https://siem.corp.com/kortix',
          enabled: true,
          action_prefix: 'iam.',
          last_delivered_at: '2026-08-01T10:00:00.000Z',
          last_error_at: null,
          last_error: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
  }
  if (p === WEBHOOKS_BASE && req.method === 'POST') {
    const b = body as { name: string; url: string; action_prefix?: string };
    if (!b.url.startsWith('http')) {
      return Response.json({ error: 'url must be http(s)' }, { status: 400 });
    }
    return Response.json(
      {
        webhook_id: 'wh_2',
        name: b.name,
        url: b.url,
        enabled: true,
        action_prefix: b.action_prefix ?? null,
        last_delivered_at: null,
        last_error_at: null,
        last_error: null,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
        secret: 'whsec_ONCE',
        test: { ok: true, status: 200 },
      },
      { status: 201 },
    );
  }
  if (p === `${WEBHOOKS_BASE}/wh_1` && req.method === 'PATCH') {
    return Response.json({
      webhook_id: 'wh_1',
      name: 'splunk',
      url: 'https://siem.corp.com/kortix',
      enabled: (body as { enabled: boolean }).enabled,
      action_prefix: 'iam.',
      last_delivered_at: null,
      last_error_at: null,
      last_error: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });
  }
  if (p === `${WEBHOOKS_BASE}/wh_1` && req.method === 'DELETE') {
    return Response.json({ deleted: true });
  }
  return undefined;
};

describe('kortix audit webhooks', () => {
  let runner: string;
  beforeEach(() => {
    runner = writeRunner(tmp, 'audit.ts', 'runAudit');
  });

  test('--help documents the webhook verbs and the entitlement boundary', async () => {
    const h = await runCommand(runner, ['--help'], { cwd: tmp });
    expect(h.code).toBe(0);
    for (const fragment of [
      'webhooks ls [--json]',
      'webhooks add --name <n> --url <u>',
      'webhooks enable <webhook-id>',
      'webhooks rm <webhook-id>',
      'account.write',
      '--action-prefix <p>',
    ]) {
      expect(h.stdout).toContain(fragment);
    }
  });

  test('webhooks ls prints state and prefix; --json emits the raw rows', async () => {
    const config = boot(auditRoutes);
    const r = await runCommand(runner, ['webhooks', 'ls'], { cwd: tmp, configFile: config });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('splunk');
    expect(r.stdout).toContain('enabled');
    expect(r.stdout).toContain('iam.');

    const j = await runCommand(runner, ['webhooks', 'ls', '--json'], {
      cwd: tmp,
      configFile: config,
    });
    expect(JSON.parse(j.stdout)[0].webhook_id).toBe('wh_1');
  });

  test('webhooks add POSTs {name,url,action_prefix}, prints the secret + test result once', async () => {
    const config = boot(auditRoutes);
    const r = await runCommand(
      runner,
      [
        'webhooks', 'add',
        '--name', 'datadog',
        '--url', 'https://siem.corp.com/dd',
        '--action-prefix', 'session.',
      ],
      { cwd: tmp, configFile: config },
    );
    expect(r.code).toBe(0);
    expect(api!.requests[0]).toMatchObject({
      method: 'POST',
      path: WEBHOOKS_BASE,
      body: { name: 'datadog', url: 'https://siem.corp.com/dd', action_prefix: 'session.' },
    });
    expect(r.stdout).toContain('whsec_ONCE');
    expect(r.stdout).toContain('only time the signing secret is shown');
    expect(r.stdout).toContain('delivered');
  });

  test('enable/disable PATCH {enabled}; rm DELETEs', async () => {
    const config = boot(auditRoutes);
    const off = await runCommand(runner, ['webhooks', 'disable', 'wh_1'], {
      cwd: tmp,
      configFile: config,
    });
    expect(off.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'PATCH',
      path: `${WEBHOOKS_BASE}/wh_1`,
      body: { enabled: false },
    });
    expect(off.stdout).toContain('splunk disabled');

    const on = await runCommand(runner, ['webhooks', 'enable', 'wh_1'], {
      cwd: tmp,
      configFile: config,
    });
    expect(on.code).toBe(0);
    expect(api!.requests.at(-1)!.body).toEqual({ enabled: true });

    const rm = await runCommand(runner, ['webhooks', 'rm', 'wh_1'], {
      cwd: tmp,
      configFile: config,
    });
    expect(rm.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `${WEBHOOKS_BASE}/wh_1`,
    });
  });

  test('a 400 surfaces; missing arguments exit 2 with no HTTP call', async () => {
    const config = boot(auditRoutes);
    const bad = await runCommand(
      runner,
      ['webhooks', 'add', '--name', 'x', '--url', 'ftp://nope'],
      { cwd: tmp, configFile: config },
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('url must be http(s)');

    api!.requests.length = 0;
    for (const args of [
      ['webhooks', 'add'],
      ['webhooks', 'add', '--name', 'x'],
      ['webhooks', 'enable'],
      ['webhooks', 'rm'],
      ['webhooks', 'bogus'],
    ]) {
      const r = await runCommand(runner, args, { cwd: tmp, configFile: config });
      expect(r.code).toBe(2);
    }
    expect(api!.requests).toHaveLength(0);
  });
});
