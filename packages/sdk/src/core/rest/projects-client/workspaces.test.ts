import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { ApiError } from '../../http/api-client';
import type { KortixAccount } from './accounts';
import type { KortixProject } from './projects';
import {
  buildWorkspaceSummaries,
  compareWorkspacesByRecent,
  getWorkspace,
  getWorkspaceBillingState,
  createWorkspaceToken,
  inviteWorkspaceMember,
  leaveWorkspace,
  listWorkspaceAssignments,
  listWorkspaceInvites,
  listWorkspaceMembers,
  listWorkspaceTokens,
  listWorkspaces,
  resolveWorkspaceAccountId,
  revokeWorkspaceToken,
  updateWorkspace,
  updateWorkspaceMemberRole,
  removeWorkspaceMember,
  cancelWorkspaceInvite,
  resendWorkspaceInvite,
  listWorkspaceRoles,
  listWorkspaceGroups,
  probeWorkspacePermissions,
  workspaceFromProject,
  workspaceRole,
} from './workspaces';

// Synthetic ids only. The workspace id (= project id) and its account id are
// ALWAYS different values here, so a mix-up of the two fails a test.
const WS_A = '11111111-1111-4111-8111-111111111111';
const ACC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WS_SHARED = '33333333-3333-4333-8333-333333333333';
const ACC_FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function project(id: string, accountId: string, extra: Partial<KortixProject> = {}): KortixProject {
  return {
    project_id: id,
    account_id: accountId,
    name: `ws-${id.slice(0, 4)}`,
    repo_url: 'https://example.invalid/repo.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function account(id: string, role: string, extra: Partial<KortixAccount> = {}): KortixAccount {
  return { account_id: id, name: `acc-${id.slice(0, 4)}`, account_role: role, ...extra };
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Array<{ method: string; match: RegExp; status: number; body: unknown }> = [];

function route(method: string, match: RegExp, body: unknown, status = 200) {
  routes.push({ method, match, status, body });
}

beforeEach(() => {
  calls = [];
  routes = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET';
    const path = String(url).replace('http://test.local', '');
    calls.push({ url: path, method, body: opts.body ? JSON.parse(String(opts.body)) : undefined });
    const hit = routes.find((r) => r.method === method && r.match.test(path));
    if (!hit) {
      return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), {
        status: 599,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

describe('workspaceRole', () => {
  test('the account role wins: owner and admin', () => {
    expect(workspaceRole({ accountRole: 'owner', projectRole: 'member' })).toBe('owner');
    expect(workspaceRole({ accountRole: 'admin', projectRole: null })).toBe('admin');
  });
  test('a project manager without an account admin role is manager', () => {
    expect(workspaceRole({ accountRole: 'member', projectRole: 'manager' })).toBe('manager');
    expect(workspaceRole({ accountRole: null, projectRole: 'manager' })).toBe('manager');
  });
  test('everything else is member', () => {
    expect(workspaceRole({ accountRole: 'member', projectRole: 'member' })).toBe('member');
    expect(workspaceRole({})).toBe('member');
    expect(workspaceRole({ accountRole: 'something-new' })).toBe('member');
  });
});

describe('workspaceFromProject', () => {
  test('workspace_id is the project id, never the account id', () => {
    const ws = workspaceFromProject(project(WS_A, ACC_A), account(ACC_A, 'owner'));
    expect(ws.workspace_id).toBe(WS_A);
    expect(ws.account_id).toBe(ACC_A);
    expect(ws.role).toBe('owner');
  });
  test('keeps every KortixProject field so a summary still works where a project is expected', () => {
    const source = project(WS_A, ACC_A, { icon: '🚀', last_opened_at: '2026-02-01T00:00:00.000Z' });
    const ws = workspaceFromProject(source, null);
    for (const [key, value] of Object.entries(source)) {
      expect((ws as unknown as Record<string, unknown>)[key]).toEqual(value);
    }
  });
  test('without an account the role comes from the effective project role', () => {
    const ws = workspaceFromProject(project(WS_A, ACC_A, { effective_project_role: 'manager' }), null);
    expect(ws.role).toBe('manager');
  });
});

describe('buildWorkspaceSummaries', () => {
  test('one summary per active project, input order, archived and duplicates dropped', () => {
    const summaries = buildWorkspaceSummaries({
      accounts: [account(ACC_A, 'owner'), account(ACC_B, 'member')],
      lists: [
        { accountId: ACC_A, data: [project(WS_A, ACC_A), project(WS_SHARED, ACC_FOREIGN)] },
        {
          accountId: ACC_B,
          data: [project(WS_B, ACC_B, { status: 'archived' }), project(WS_SHARED, ACC_FOREIGN)],
        },
      ],
    });
    expect(summaries.map((s) => s.workspace_id)).toEqual([WS_A, WS_SHARED]);
    expect(summaries[0].role).toBe('owner');
    // Shared into an account the caller is not a member of: still listed.
    expect(summaries[1].role).toBe('member');
  });

  test('an account whose list is unknown adds nothing', () => {
    const summaries = buildWorkspaceSummaries({
      accounts: [account(ACC_A, 'owner')],
      lists: [{ accountId: ACC_A, data: undefined }],
    });
    expect(summaries).toEqual([]);
  });
});

describe('compareWorkspacesByRecent', () => {
  test('most recently opened first, then by name', () => {
    const rows = [
      workspaceFromProject(project(WS_A, ACC_A, { name: 'b', last_opened_at: null }), null),
      workspaceFromProject(project(WS_B, ACC_B, { name: 'a', last_opened_at: null }), null),
      workspaceFromProject(
        project(WS_SHARED, ACC_FOREIGN, { name: 'z', last_opened_at: '2026-03-01T00:00:00.000Z' }),
        null,
      ),
    ];
    expect(rows.sort(compareWorkspacesByRecent).map((r) => r.name)).toEqual(['z', 'a', 'b']);
  });
});

describe('listWorkspaces', () => {
  test('reads the accounts, then each account\'s projects, and returns one flat list, most recent first', async () => {
    route('GET', /^\/accounts$/, [account(ACC_A, 'owner'), account(ACC_B, 'admin')]);
    route('GET', new RegExp(`^/workspaces\\?account_id=${ACC_A}$`), [
      project(WS_A, ACC_A, { last_opened_at: '2026-01-02T00:00:00.000Z' }),
    ]);
    route('GET', new RegExp(`^/workspaces\\?account_id=${ACC_B}$`), [
      project(WS_B, ACC_B, { last_opened_at: '2026-01-03T00:00:00.000Z' }),
    ]);

    const workspaces = await listWorkspaces();
    expect(workspaces.map((w) => [w.workspace_id, w.role])).toEqual([
      [WS_B, 'admin'],
      [WS_A, 'owner'],
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      '/accounts',
      `/workspaces?account_id=${ACC_A}`,
      `/workspaces?account_id=${ACC_B}`,
    ]);
  });

  test('an account with no project (a dormant account) is not a workspace', async () => {
    route('GET', /^\/accounts$/, [account(ACC_A, 'owner'), account(ACC_B, 'owner')]);
    route('GET', new RegExp(`account_id=${ACC_A}`), [project(WS_A, ACC_A)]);
    route('GET', new RegExp(`account_id=${ACC_B}`), []);
    expect((await listWorkspaces()).map((w) => w.workspace_id)).toEqual([WS_A]);
  });

  test('one account whose list fails does not hide the others', async () => {
    route('GET', /^\/accounts$/, [account(ACC_A, 'owner'), account(ACC_B, 'owner')]);
    route('GET', new RegExp(`account_id=${ACC_A}`), [project(WS_A, ACC_A)]);
    route('GET', new RegExp(`account_id=${ACC_B}`), { error: 'boom' }, 500);
    expect((await listWorkspaces()).map((w) => w.workspace_id)).toEqual([WS_A]);
  });

  test('rejects when every account list fails: an error is not "no workspaces"', async () => {
    route('GET', /^\/accounts$/, [account(ACC_A, 'owner')]);
    route('GET', new RegExp(`account_id=${ACC_A}`), { error: 'boom' }, 500);
    await expect(listWorkspaces()).rejects.toBeInstanceOf(ApiError);
  });

  test('a caller with no account has no workspace', async () => {
    route('GET', /^\/accounts$/, []);
    expect(await listWorkspaces()).toEqual([]);
  });
});

describe('getWorkspace', () => {
  function settingsBlock(extra: Record<string, unknown> = {}) {
    return {
      workspace_id: WS_A,
      account_id: ACC_A,
      split_pending: false,
      member_count: 3,
      account_role: 'admin',
      mfa_required: true,
      session_max_lifetime_minutes: null,
      session_idle_timeout_minutes: null,
      pat_max_lifetime_days: null,
      pat_require_expiry: false,
      pat_idle_revoke_days: null,
      admins_see_all_sessions: false,
      automations_paused_at: null,
      setup_complete_at: '2026-01-02T00:00:00.000Z',
      branding: null,
      ...extra,
    };
  }

  test('one GET /workspaces/:id: the workspace with its settings block and the caller role', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}$`), {
      ...project(WS_A, ACC_A),
      workspace_id: WS_A,
      workspace: settingsBlock(),
    });
    const ws = await getWorkspace(WS_A);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /workspaces/${WS_A}`]);
    expect(ws.workspace_id).toBe(WS_A);
    expect(ws.account_id).toBe(ACC_A);
    expect(ws.role).toBe('admin');
    expect(ws.mfa_required).toBe(true);
    expect(ws.member_count).toBe(3);
    expect(ws.branding).toBeNull();
    expect(ws.split_pending).toBe(false);
    expect(ws.setup_complete_at).toBe('2026-01-02T00:00:00.000Z');
    expect((ws as unknown as Record<string, unknown>).workspace).toBeUndefined();
    expect((ws as unknown as Record<string, unknown>).account_role).toBeUndefined();
  });

  test('a caller with a project grant and no account role is the project role', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}$`), {
      ...project(WS_A, ACC_A, { effective_project_role: 'manager' }),
      workspace: settingsBlock({ account_role: null }),
    });
    const ws = await getWorkspace(WS_A);
    expect(ws.role).toBe('manager');
  });

  test('a response with no settings block falls back to the account read', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}$`), project(WS_A, ACC_A));
    route('GET', new RegExp(`^/accounts/${ACC_A}$`), {
      account_id: ACC_A,
      name: 'acc',
      member_count: 3,
      project_count: 1,
      role: 'owner',
      mfa_required: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const ws = await getWorkspace(WS_A);
    expect(ws.role).toBe('owner');
    expect(calls.map((c) => c.url)).toEqual([`/workspaces/${WS_A}`, `/accounts/${ACC_A}`]);
  });

  test('no settings block and no account membership: the workspace without settings', async () => {
    route(
      'GET',
      new RegExp(`^/workspaces/${WS_A}$`),
      project(WS_A, ACC_A, { effective_project_role: 'member' }),
    );
    route('GET', new RegExp(`^/accounts/${ACC_A}$`), { error: 'forbidden' }, 403);
    const ws = await getWorkspace(WS_A);
    expect(ws.workspace_id).toBe(WS_A);
    expect(ws.role).toBe('member');
    expect(ws.mfa_required).toBeUndefined();
  });

  test('a missing workspace rejects with the 404', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}$`), { error: 'not found' }, 404);
    await expect(getWorkspace(WS_A)).rejects.toMatchObject({ status: 404 });
  });

  test('a response that already names its role needs no second read', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}$`), {
      ...project(WS_A, ACC_A),
      workspace_id: WS_A,
      role: 'owner',
      mfa_required: false,
    });
    const ws = await getWorkspace(WS_A);
    expect(ws.role).toBe('owner');
    expect(calls.map((c) => c.url)).toEqual([`/workspaces/${WS_A}`]);
  });
});

describe('updateWorkspace', () => {
  test('PATCHes /workspaces/:id and answers with a workspace', async () => {
    route('PATCH', new RegExp(`^/workspaces/${WS_A}$`), project(WS_A, ACC_A, { name: 'Renamed' }));
    const ws = await updateWorkspace(WS_A, { name: 'Renamed' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `/workspaces/${WS_A}`, body: { name: 'Renamed' } });
    expect(ws.workspace_id).toBe(WS_A);
    expect(ws.name).toBe('Renamed');
  });
});

describe('workspace-scoped clients call /workspaces/:id with no account lookup', () => {
  test('resolveWorkspaceAccountId reads the workspace and returns its account', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}$`), project(WS_A, ACC_A));
    expect(await resolveWorkspaceAccountId(WS_A)).toBe(ACC_A);
    expect(calls.map((c) => c.url)).toEqual([`/workspaces/${WS_A}`]);
  });

  test('members, invites and leave: one request each, keyed by the workspace id', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}/members$`), []);
    route('POST', new RegExp(`^/workspaces/${WS_A}/members$`), { status: 'added', user_id: 'u1' });
    route('PATCH', new RegExp(`^/workspaces/${WS_A}/members/u1$`), { user_id: 'u1' });
    route('DELETE', new RegExp(`^/workspaces/${WS_A}/members/u1$`), { ok: true });
    route('GET', new RegExp(`^/workspaces/${WS_A}/invites$`), []);
    route('DELETE', new RegExp(`^/workspaces/${WS_A}/invites/i1$`), { ok: true });
    route('POST', new RegExp(`^/workspaces/${WS_A}/invites/i1/resend$`), { ok: true });
    route('POST', new RegExp(`^/workspaces/${WS_A}/leave$`), { ok: true });

    await listWorkspaceMembers(WS_A);
    await inviteWorkspaceMember(WS_A, { email: 'person@example.invalid', role: 'member' });
    await updateWorkspaceMemberRole(WS_A, 'u1', 'admin');
    await removeWorkspaceMember(WS_A, 'u1');
    await listWorkspaceInvites(WS_A);
    await cancelWorkspaceInvite(WS_A, 'i1');
    await resendWorkspaceInvite(WS_A, 'i1');
    await leaveWorkspace(WS_A);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /workspaces/${WS_A}/members`,
      `POST /workspaces/${WS_A}/members`,
      `PATCH /workspaces/${WS_A}/members/u1`,
      `DELETE /workspaces/${WS_A}/members/u1`,
      `GET /workspaces/${WS_A}/invites`,
      `DELETE /workspaces/${WS_A}/invites/i1`,
      `POST /workspaces/${WS_A}/invites/i1/resend`,
      `POST /workspaces/${WS_A}/leave`,
    ]);
    expect(calls[1].body).toEqual({ email: 'person@example.invalid', role: 'member' });
    expect(calls[2].body).toEqual({ role: 'admin' });
  });

  test('tokens live under the workspace', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}/tokens(\\?|$)`), []);
    route('POST', new RegExp(`^/workspaces/${WS_A}/tokens$`), { token_id: 't1', secret_key: 'kortix_pat_x' });
    route('DELETE', new RegExp(`^/workspaces/${WS_A}/tokens/t1(\\?|$)`), { ok: true });

    await listWorkspaceTokens(WS_A, { mine: true });
    await listWorkspaceTokens(WS_A);
    await createWorkspaceToken(WS_A, { name: 'ci', expiresAt: '2027-01-01T00:00:00.000Z' });
    await revokeWorkspaceToken(WS_A, 't1');
    await revokeWorkspaceToken(WS_A, 't1', { deleteRevoked: true });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /workspaces/${WS_A}/tokens?mine=true`,
      `GET /workspaces/${WS_A}/tokens`,
      `POST /workspaces/${WS_A}/tokens`,
      `DELETE /workspaces/${WS_A}/tokens/t1`,
      `DELETE /workspaces/${WS_A}/tokens/t1?delete_revoked=true`,
    ]);
    expect(calls[2].body).toEqual({ name: 'ci', expires_at: '2027-01-01T00:00:00.000Z' });
  });

  test('billing passes the workspace id as account_id (the API accepts either id)', async () => {
    route('GET', /^\/billing\/account-state\?/, { credits: {} });
    await getWorkspaceBillingState(WS_A);
    expect(calls.map((c) => c.url)).toEqual([`/billing/account-state?account_id=${WS_A}`]);
  });

  test('IAM: assignments, roles, groups and probes under /workspaces/:id/iam', async () => {
    route('GET', new RegExp(`^/workspaces/${WS_A}/iam/assignments`), { assignments: [] });
    route('GET', new RegExp(`^/workspaces/${WS_A}/iam/roles$`), { roles: [] });
    route('GET', new RegExp(`^/workspaces/${WS_A}/iam/groups$`), { groups: [] });
    route('POST', new RegExp(`^/workspaces/${WS_A}/iam/members/u1/effective:batch$`), { results: [] });
    expect(await listWorkspaceAssignments(WS_A)).toEqual([]);
    expect(await listWorkspaceRoles(WS_A)).toEqual([]);
    expect(await listWorkspaceGroups(WS_A)).toEqual([]);
    expect(await probeWorkspacePermissions(WS_A, 'u1', [{ action: 'project.read' }])).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /workspaces/${WS_A}/iam/assignments`,
      `GET /workspaces/${WS_A}/iam/roles`,
      `GET /workspaces/${WS_A}/iam/groups`,
      `POST /workspaces/${WS_A}/iam/members/u1/effective:batch`,
    ]);
  });
});
