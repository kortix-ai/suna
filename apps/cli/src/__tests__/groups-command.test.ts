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
const GROUP = '33333333-3333-4333-8333-333333333333';
const ALICE = '11111111-1111-4111-8111-111111111111';
const IAM = `/v1/accounts/${ACCOUNT}/iam`;

let tmp: string;
let runner: string;
let api: FakeApi | null = null;

const GROUPS = [
  {
    group_id: GROUP,
    name: 'Engineering',
    description: 'Everyone who ships code',
    source: 'local',
    member_count: 2,
    project_count: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    group_id: '44444444-4444-4444-8444-444444444444',
    name: 'Support',
    description: null,
    source: 'scim',
    member_count: 5,
    project_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

const routes: Parameters<typeof startFakeApi>[0] = (req, url, body) => {
  const p = url.pathname;
  if (p === `/v1/accounts/${ACCOUNT}/members` && req.method === 'GET') {
    return Response.json([
      {
        user_id: ALICE,
        email: 'alice@corp.com',
        account_role: 'member',
        is_super_admin: false,
        explicit_project_count: 0,
        projects: [],
        groups: [],
        active_pat_count: 0,
        has_verified_mfa: false,
        joined_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
  }
  if (p === `${IAM}/groups` && req.method === 'GET') return Response.json({ groups: GROUPS });
  if (p === `${IAM}/groups` && req.method === 'POST') {
    const b = body as { name: string; description?: string };
    if (b.name === 'Engineering') {
      return Response.json({ error: 'A group with this name already exists' }, { status: 409 });
    }
    return Response.json(
      {
        group_id: 'new-group-id',
        name: b.name,
        description: b.description ?? null,
        source: 'local',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      { status: 201 },
    );
  }
  if (p === `${IAM}/groups/${GROUP}` && req.method === 'PATCH') {
    const b = body as { name?: string; description?: string | null };
    return Response.json({
      group_id: GROUP,
      name: b.name ?? 'Engineering',
      description: b.description === undefined ? 'Everyone who ships code' : b.description,
      source: 'local',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });
  }
  if (p === `${IAM}/groups/${GROUP}` && req.method === 'DELETE') {
    return Response.json({ deleted: true });
  }
  if (p === `${IAM}/groups/${GROUP}/members` && req.method === 'GET') {
    return Response.json({
      members: [{ user_id: ALICE, added_at: '2026-02-01T00:00:00.000Z', added_by: ALICE }],
    });
  }
  if (p === `${IAM}/groups/${GROUP}/members` && req.method === 'POST') {
    return Response.json({ added: (body as { userIds: string[] }).userIds.length });
  }
  if (p === `${IAM}/groups/${GROUP}/members/${ALICE}` && req.method === 'DELETE') {
    return Response.json({ removed: true });
  }
  if (p === `${IAM}/groups/${GROUP}/project-grants` && req.method === 'GET') {
    return Response.json({
      grants: [
        {
          project_id: 'p1',
          project_name: 'Web',
          role: 'manager',
          granted_by: ALICE,
          created_at: '2026-03-01T00:00:00.000Z',
          expires_at: null,
        },
      ],
    });
  }
  return undefined;
};

function boot(): string {
  api = startFakeApi(routes);
  return writeConfig(tmp, api.url, ACCOUNT);
}

describe('kortix groups', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-groups-'));
    runner = writeRunner(tmp, 'groups.ts', 'runGroups');
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
      'Usage: kortix groups',
      'create <name>',
      'members <group>',
      'add <group> <user>...',
      'projects <group>',
      'group.read',
      'kortix access grant --group',
    ]) {
      expect(h.stdout).toContain(fragment);
    }
    const bare = await runCommand(runner, [], { cwd: tmp });
    expect(bare.code).toBe(2);
  });

  test('ls prints counts and source; --json emits the raw rows', async () => {
    const config = boot();
    const r = await runCommand(runner, ['ls'], { cwd: tmp, configFile: config });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Engineering\s+2\s+1\s+local/);
    expect(r.stdout).toMatch(/Support\s+5\s+0\s+scim/);
    expect(api!.requests[0]).toMatchObject({ method: 'GET', path: `${IAM}/groups` });

    const j = await runCommand(runner, ['ls', '--json'], { cwd: tmp, configFile: config });
    expect(JSON.parse(j.stdout).map((g: { name: string }) => g.name)).toEqual([
      'Engineering',
      'Support',
    ]);
  });

  test('create POSTs {name, description}', async () => {
    const config = boot();
    const r = await runCommand(runner, ['create', 'Design', '--description', 'Pixel people'], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(0);
    expect(api!.requests[0]).toMatchObject({
      method: 'POST',
      path: `${IAM}/groups`,
      body: { name: 'Design', description: 'Pixel people' },
    });
    expect(r.stdout).toContain('Created group Design');
  });

  test('set resolves a group by NAME, then PATCHes only the fields given', async () => {
    const config = boot();
    const rename = await runCommand(runner, ['set', 'Engineering', '--name', 'Eng'], {
      cwd: tmp,
      configFile: config,
    });
    expect(rename.code).toBe(0);
    expect(api!.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      `GET ${IAM}/groups`,
      `PATCH ${IAM}/groups/${GROUP}`,
    ]);
    expect(api!.requests[1]!.body).toEqual({ name: 'Eng' });

    const clear = await runCommand(runner, ['set', GROUP, '--no-description'], {
      cwd: tmp,
      configFile: config,
    });
    expect(clear.code).toBe(0);
    expect(api!.requests.at(-1)!.body).toEqual({ description: null });
  });

  test('members lists a group and labels user ids with their email', async () => {
    const config = boot();
    const r = await runCommand(runner, ['members', 'Engineering'], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('alice@corp.com');
    expect(r.stdout).toContain('1 member in Engineering');
  });

  test('add resolves each email and POSTs one {userIds} batch', async () => {
    const config = boot();
    const r = await runCommand(runner, ['add', 'Engineering', 'alice@corp.com', ALICE], {
      cwd: tmp,
      configFile: config,
    });
    expect(r.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `${IAM}/groups/${GROUP}/members`,
      body: { userIds: [ALICE, ALICE] },
    });
    expect(r.stdout).toContain('2 added to Engineering');
  });

  test('remove DELETEs one member; projects lists the group reach', async () => {
    const config = boot();
    const rm = await runCommand(runner, ['remove', 'Engineering', 'alice@corp.com'], {
      cwd: tmp,
      configFile: config,
    });
    expect(rm.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `${IAM}/groups/${GROUP}/members/${ALICE}`,
    });

    const projects = await runCommand(runner, ['projects', 'Engineering'], {
      cwd: tmp,
      configFile: config,
    });
    expect(projects.code).toBe(0);
    expect(projects.stdout).toMatch(/Web\s+manager\s+never/);
  });

  test('rm -y deletes; an unknown group never reaches the delete route', async () => {
    const config = boot();
    const ok = await runCommand(runner, ['rm', 'Engineering', '-y'], {
      cwd: tmp,
      configFile: config,
    });
    expect(ok.code).toBe(0);
    expect(api!.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `${IAM}/groups/${GROUP}`,
    });

    const miss = await runCommand(runner, ['rm', 'Nope', '-y'], { cwd: tmp, configFile: config });
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain('No group "Nope" in this account');
  });

  test('a 409 from the API surfaces its message and exits 1', async () => {
    const config = boot();
    const r = await runCommand(runner, ['create', 'Engineering'], { cwd: tmp, configFile: config });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A group with this name already exists');
  });

  test('missing required arguments exit 2 without any HTTP call', async () => {
    const config = boot();
    for (const args of [['create'], ['set'], ['members'], ['add', 'Engineering'], ['remove']]) {
      const r = await runCommand(runner, args, { cwd: tmp, configFile: config });
      expect(r.code).toBe(2);
    }
    expect(api!.requests).toHaveLength(0);
  });
});
