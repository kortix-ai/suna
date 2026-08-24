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
const ALICE = '11111111-1111-4111-8111-111111111111';

let tmp: string;
let runner: string;
let api: FakeApi | null = null;

const MEMBERS = [
  {
    user_id: ALICE,
    email: 'alice@corp.com',
    account_role: 'admin',
    is_super_admin: false,
    explicit_project_count: 2,
    projects: [{ project_id: 'p1', name: 'Web', role: 'manager' }],
    groups: [{ group_id: 'g1', name: 'Engineering' }],
    active_pat_count: 1,
    has_verified_mfa: true,
    joined_at: '2026-01-01T00:00:00.000Z',
  },
  {
    user_id: '22222222-2222-4222-8222-222222222222',
    email: 'bob@corp.com',
    account_role: 'member',
    is_super_admin: false,
    explicit_project_count: 0,
    projects: [],
    groups: [],
    active_pat_count: 0,
    has_verified_mfa: false,
    joined_at: '2026-02-01T00:00:00.000Z',
  },
];

function boot(handler: Parameters<typeof startFakeApi>[0]): string {
  api = startFakeApi(handler);
  return writeConfig(tmp, api.url, ACCOUNT);
}

/** Routes every members subcommand needs, so one server serves all of them. */
const defaultRoutes: Parameters<typeof startFakeApi>[0] = (req, url, body) => {
  const p = url.pathname;
  if (p === `/v1/accounts/${ACCOUNT}/members` && req.method === 'GET') {
    return Response.json(MEMBERS);
  }
  if (p === `/v1/accounts/${ACCOUNT}/members` && req.method === 'POST') {
    const b = body as { email: string; role: string };
    if (!b.email.includes('@')) {
      return Response.json({ error: 'A valid email is required' }, { status: 400 });
    }
    return Response.json(
      {
        status: 'pending',
        invite_id: 'inv_1',
        email: b.email,
        account_role: b.role,
        project_grants: (body as { project_grants?: unknown[] }).project_grants ?? [],
        expires_at: '2026-09-01T00:00:00.000Z',
        invite_url: 'https://kortix.test/invite/inv_1',
        email_sent: true,
        email_skip_reason: null,
      },
      { status: 201 },
    );
  }
  if (p === `/v1/accounts/${ACCOUNT}/members/${ALICE}` && req.method === 'PATCH') {
    return Response.json({ user_id: ALICE, account_role: (body as { role: string }).role });
  }
  if (p === `/v1/accounts/${ACCOUNT}/members/${ALICE}` && req.method === 'DELETE') {
    return Response.json({ ok: true });
  }
  if (p === `/v1/accounts/${ACCOUNT}/iam/members/${ALICE}/super-admin` && req.method === 'PATCH') {
    return Response.json({
      user_id: ALICE,
      is_super_admin: (body as { isSuperAdmin: boolean }).isSuperAdmin,
    });
  }
  if (p === `/v1/accounts/${ACCOUNT}/invites` && req.method === 'GET') {
    return Response.json([
      {
        invite_id: 'inv_1',
        email: 'carol@corp.com',
        initial_role: 'member',
        invited_by: ALICE,
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-08-15T00:00:00.000Z',
        invite_url: 'https://kortix.test/invite/inv_1',
      },
    ]);
  }
  if (p === `/v1/accounts/${ACCOUNT}/invites/inv_1` && req.method === 'DELETE') {
    return Response.json({ ok: true });
  }
  if (p === `/v1/accounts/${ACCOUNT}/invites/inv_1/resend` && req.method === 'POST') {
    return Response.json({
      ok: true,
      expires_at: '2026-09-01T00:00:00.000Z',
      invite_url: 'https://kortix.test/invite/inv_1',
      email_sent: true,
      email_skip_reason: null,
    });
  }
  return undefined;
};

describe('kortix members', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-members-'));
    runner = writeRunner(tmp, 'members.ts', 'runMembers');
  });

  afterEach(() => {
    api?.stop();
    api = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('--help documents every subcommand; no args exits 2', async () => {
    const h = await runCommand(runner, ['--help'], { cwd: tmp });
    expect(h.code).toBe(0);
    for (const fragment of [
      'Usage: kortix members',
      'invite <email> --role <r>',
      'set-role <user|email> --role <r>',
      'super-admin <user|email> on|off',
      'invites ls',
      'invites resend <invite-id>',
      'member.invite',
      'member.remove',
    ]) {
      expect(h.stdout).toContain(fragment);
    }

    const bare = await runCommand(runner, [], { cwd: tmp });
    expect(bare.code).toBe(2);
    expect(bare.stdout).toContain('Usage: kortix members');
  });

  test('ls prints the directory; --json emits the raw rows', async () => {
    const config = boot(defaultRoutes);
    const r = await runCommand(runner, ['ls'], { cwd: tmp, configFile: config });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/alice@corp\.com\s+admin\s+2\s+yes/);
    expect(r.stdout).toMatch(/bob@corp\.com\s+member\s+0\s+no/);
    expect(r.stdout).toContain('Engineering');
    expect(api!.requests[0]).toMatchObject({
      method: 'GET',
      path: `/v1/accounts/${ACCOUNT}/members`,
    });

    const j = await runCommand(runner, ['ls', '--json'], { cwd: tmp, configFile: config });
    expect(j.code).toBe(0);
    expect(JSON.parse(j.stdout).map((m: { email: string }) => m.email)).toEqual([
      'alice@corp.com',
      'bob@corp.com',
    ]);
  });

  test('invite POSTs {email, role, project_grants} and prints the invite link', async () => {
    const config = boot(defaultRoutes);
    const r = await runCommand(
      runner,
      ['invite', 'carol@corp.com', '--role', 'member', '--project', 'p1:manager', '--project', 'p2'],
      { cwd: tmp, configFile: config },
    );
    expect(r.code).toBe(0);
    expect(api!.requests[0]).toMatchObject({
      method: 'POST',
      path: `/v1/accounts/${ACCOUNT}/members`,
      body: {
        email: 'carol@corp.com',
        role: 'member',
        project_grants: [
          { project_id: 'p1', role: 'manager' },
          { project_id: 'p2', role: 'member' },
        ],
      },
    });
    expect(r.stdout).toContain('Invited carol@corp.com as member');
    expect(r.stdout).toContain('https://kortix.test/invite/inv_1');
  });

  test('invite --role owner is refused locally (the API would silently downgrade it)', async () => {
    const config = boot(defaultRoutes);
    const r = await runCommand(runner, ['invite', 'carol@corp.com', '--role', 'owner'], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('An invite cannot grant owner');
    expect(api!.requests).toHaveLength(0);
  });

  test('set-role resolves an email to a user id, then PATCHes {role}', async () => {
    const config = boot(defaultRoutes);
    const r = await runCommand(runner, ['set-role', 'alice@corp.com', '--role', 'owner'], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(0);
    expect(api!.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      `GET /v1/accounts/${ACCOUNT}/members`,
      `PATCH /v1/accounts/${ACCOUNT}/members/${ALICE}`,
    ]);
    expect(api!.requests[1]!.body).toEqual({ role: 'owner' });
    expect(r.stdout).toContain('alice@corp.com → owner');
  });

  test('rm -y DELETEs the member; an unknown email never reaches the API', async () => {
    const config = boot(defaultRoutes);
    const ok = await runCommand(runner, ['rm', 'alice@corp.com', '-y'], {
      cwd: tmp,
      configFile: config,
    });
    expect(ok.code).toBe(0);
    expect(api!.requests[1]).toMatchObject({
      method: 'DELETE',
      path: `/v1/accounts/${ACCOUNT}/members/${ALICE}`,
    });

    const miss = await runCommand(runner, ['rm', 'nobody@corp.com', '-y'], {
      cwd: tmp,
      configFile: config,
    });
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain('No member with email "nobody@corp.com"');
  });

  test('super-admin on PATCHes {isSuperAdmin:true}; a bad state exits 2', async () => {
    const config = boot(defaultRoutes);
    const r = await runCommand(runner, ['super-admin', 'alice@corp.com', 'on'], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(0);
    expect(api!.requests[1]).toMatchObject({
      method: 'PATCH',
      path: `/v1/accounts/${ACCOUNT}/iam/members/${ALICE}/super-admin`,
      body: { isSuperAdmin: true },
    });
    expect(r.stdout).toContain('super-admin on');

    const bad = await runCommand(runner, ['super-admin', 'alice@corp.com', 'maybe'], {
      cwd: tmp,
      configFile: config,
    });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('Pass on or off');
  });

  test('invites ls/cancel/resend hit the account-scoped routes', async () => {
    const config = boot(defaultRoutes);
    const ls = await runCommand(runner, ['invites', 'ls'], { cwd: tmp, configFile: config });
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/carol@corp\.com\s+member\s+2026-08-15/);

    const cancel = await runCommand(runner, ['invites', 'cancel', 'inv_1'], {
      cwd: tmp,
      configFile: config,
    });
    expect(cancel.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/v1/accounts/${ACCOUNT}/invites/inv_1`,
    });

    const resend = await runCommand(runner, ['invites', 'resend', 'inv_1'], {
      cwd: tmp,
      configFile: config,
    });
    expect(resend.code).toBe(0);
    expect(resend.stdout).toContain('Re-sent invite inv_1');
  });

  test('a 4xx from the API surfaces its message and exits 1', async () => {
    const config = boot(defaultRoutes);
    const r = await runCommand(runner, ['invite', 'not-an-email', '--role', 'member'], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A valid email is required');
  });

  test('missing required arguments exit 2 without any HTTP call', async () => {
    const config = boot(defaultRoutes);
    for (const args of [['invite'], ['invite', 'a@b.com'], ['set-role'], ['rm'], ['groups']]) {
      const r = await runCommand(runner, args, { cwd: tmp, configFile: config });
      expect(r.code).toBe(2);
    }
    expect(api!.requests).toHaveLength(0);
  });
});
