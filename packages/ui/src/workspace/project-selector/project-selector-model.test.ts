import { describe, expect, test } from 'bun:test';

import { accountInviteLanding, type KortixAccount, type KortixProject } from '@kortix/sdk';

import {
  buildWorkspaceRows,
  canCreateWorkspace,
  decideDoor,
  failedAccountIds,
  filterWorkspaceRows,
  inviteLandingPath,
  reusableEmptyAccount,
  type ProjectListResult,
} from './project-selector-model';

function account(
  id: string,
  role: KortixAccount['account_role'],
  overrides: Partial<KortixAccount> = {},
): KortixAccount {
  return { account_id: id, name: `Account ${id}`, account_role: role, ...overrides } as KortixAccount;
}

function project(id: string, accountId: string, overrides: Partial<KortixProject> = {}): KortixProject {
  return {
    project_id: id,
    account_id: accountId,
    name: `Project ${id}`,
    status: 'active',
    last_opened_at: null,
    ...overrides,
  } as KortixProject;
}

function list(accountId: string, data: KortixProject[] | undefined, isError = false): ProjectListResult {
  return { accountId, data, isError };
}

describe('buildWorkspaceRows — one flat row per workspace', () => {
  test('an account with no project is not a workspace', () => {
    expect(buildWorkspaceRows({ accounts: [account('a', 'owner')], lists: [list('a', [])] })).toEqual([]);
  });

  test('a legacy account with two projects shows two workspaces, with no account heading', () => {
    const rows = buildWorkspaceRows({
      accounts: [account('a', 'admin')],
      lists: [list('a', [project('p1', 'a'), project('p2', 'a')])],
    });
    expect(rows.map((row) => row.workspaceId)).toEqual(['p1', 'p2']);
    expect(rows.every((row) => row.role === 'admin' && row.accountId === 'a')).toBe(true);
  });

  test('workspaces from every account sort by most recently opened, then by name', () => {
    const rows = buildWorkspaceRows({
      accounts: [account('a', 'owner'), account('b', 'member')],
      lists: [
        list('a', [project('old', 'a', { last_opened_at: '2026-01-01T00:00:00Z' }), project('zz', 'a', { name: 'Zed' })]),
        list('b', [project('new', 'b', { last_opened_at: '2026-06-01T00:00:00Z' }), project('aa', 'b', { name: 'Ada' })]),
      ],
    });
    expect(rows.map((row) => row.workspaceId)).toEqual(['new', 'old', 'aa', 'zz']);
  });

  test('archived projects are not offered, and a project listed twice is listed once', () => {
    const rows = buildWorkspaceRows({
      accounts: [account('a', 'owner')],
      lists: [list('a', [project('p1', 'a'), project('gone', 'a', { status: 'archived' })]), list('a', [project('p1', 'a')])],
    });
    expect(rows.map((row) => row.workspaceId)).toEqual(['p1']);
  });

  test('a project in an account the user is not a member of is still listed, as a member', () => {
    const rows = buildWorkspaceRows({ accounts: [], lists: [list('x', [project('shared', 'x')])] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: 'shared', role: 'member', accountName: 'Account' });
  });
});

describe('filterWorkspaceRows', () => {
  const rows = buildWorkspaceRows({
    accounts: [account('a', 'owner', { name: 'Acme' })],
    lists: [list('a', [project('p1', 'a', { name: 'Website' }), project('p2', 'a', { name: 'Docs site' })])],
  });

  test('matches every word of the workspace name, in any order', () => {
    expect(filterWorkspaceRows(rows, 'SITE docs').map((row) => row.workspaceId)).toEqual(['p2']);
  });

  test('does not match the account name: the account is not a separate thing', () => {
    expect(filterWorkspaceRows(rows, 'acme')).toEqual([]);
  });

  test('an empty query returns the input unchanged', () => {
    expect(filterWorkspaceRows(rows, '  ')).toBe(rows);
  });
});

describe('failedAccountIds', () => {
  test('names only the accounts whose list failed', () => {
    expect(failedAccountIds([list('a', []), list('b', undefined, true)])).toEqual(['b']);
  });
});

describe('reusableEmptyAccount — what Create workspace fills', () => {
  test('the newest owned account with no active project', () => {
    const reused = reusableEmptyAccount({
      accounts: [
        account('older', 'owner', { created_at: '2026-01-01T00:00:00Z' }),
        account('newer', 'owner', { created_at: '2026-05-01T00:00:00Z' }),
      ],
      lists: [list('older', []), list('newer', [project('gone', 'newer', { status: 'archived' })])],
    });
    expect(reused?.account_id).toBe('newer');
  });

  test('ownership is the role: an account whose id is not the user id still counts', () => {
    expect(reusableEmptyAccount({ accounts: [account('acc_x', 'owner')], lists: [list('acc_x', [])] })?.account_id).toBe(
      'acc_x',
    );
  });

  test('an admin or member account, a non-empty account, a failed or unread list is never reused', () => {
    expect(
      reusableEmptyAccount({
        accounts: [account('admin', 'admin'), account('full', 'owner'), account('failed', 'owner'), account('unread', 'owner')],
        lists: [list('admin', []), list('full', [project('p', 'full')]), list('failed', undefined, true)],
      }),
    ).toBeNull();
  });
});

describe('canCreateWorkspace', () => {
  test('open everywhere unless the instance restricts account creation', () => {
    expect(canCreateWorkspace({ restricted: false, isPlatformAdmin: false, reusableAccount: null })).toBe(true);
    expect(canCreateWorkspace({ restricted: true, isPlatformAdmin: false, reusableAccount: null })).toBe(false);
  });

  test('a restricted instance still lets a platform admin, or the owner of an empty account, create', () => {
    expect(canCreateWorkspace({ restricted: true, isPlatformAdmin: true, reusableAccount: null })).toBe(true);
    expect(canCreateWorkspace({ restricted: true, isPlatformAdmin: false, reusableAccount: account('a', 'owner') })).toBe(
      true,
    );
  });
});

describe('decideDoor — skip the chooser only for one obvious answer', () => {
  const rows = buildWorkspaceRows({
    accounts: [account('a', 'owner'), account('b', 'member')],
    lists: [list('a', [project('p1', 'a'), project('p2', 'a')]), list('b', [project('p3', 'b')])],
  });

  test('the remembered workspace opens directly', () => {
    expect(decideDoor({ workspaces: rows, inviteCount: 0, rememberedProjectId: 'p3' })).toEqual({
      kind: 'open',
      projectId: 'p3',
      accountId: 'b',
    });
  });

  test('a remembered workspace the user lost access to falls back to the chooser', () => {
    expect(decideDoor({ workspaces: rows, inviteCount: 0, rememberedProjectId: 'gone' })).toEqual({ kind: 'select' });
  });

  test('exactly one workspace opens directly; none shows the chooser, never a form', () => {
    expect(decideDoor({ workspaces: rows.slice(0, 1), inviteCount: 0, rememberedProjectId: null })).toMatchObject({
      kind: 'open',
    });
    expect(decideDoor({ workspaces: [], inviteCount: 0, rememberedProjectId: null })).toEqual({ kind: 'select' });
  });

  test('a pending invite always shows the chooser, even with a remembered workspace', () => {
    expect(decideDoor({ workspaces: rows, inviteCount: 1, rememberedProjectId: 'p1' })).toEqual({ kind: 'select' });
  });

  test("a requested account bounds the answer and wins over a pending invite", () => {
    expect(
      decideDoor({ workspaces: rows, inviteCount: 1, rememberedProjectId: 'p1', requestedAccountId: 'b' }),
    ).toEqual({ kind: 'open', projectId: 'p3', accountId: 'b' });
    expect(
      decideDoor({ workspaces: rows, inviteCount: 0, rememberedProjectId: 'p3', requestedAccountId: 'a' }),
    ).toEqual({ kind: 'select' });
  });
});

describe('inviteLandingPath — the route of an accepted invite', () => {
  test('a project landing opens that project', () => {
    expect(inviteLandingPath({ kind: 'project', projectId: 'pw', accountId: 'b' })).toBe('/projects/pw');
  });

  test('an account landing goes to the door for the joined account', () => {
    expect(inviteLandingPath({ kind: 'account', accountId: 'b' })).toBe('/projects/start?account=b');
  });

  // The web hosts' three inputs, through the SDK rule.
  test('an accept that granted a project, a re-opened project invite, a workspace invite', () => {
    expect(inviteLandingPath(accountInviteLanding({ account_id: 'b', bootstrap_grants_applied: [{ project_id: 'pw' }] }))).toBe(
      '/projects/pw',
    );
    const described = {
      account_id: 'b',
      projects: [
        { project_id: 'pw', name: 'Website', role: 'member' },
        { project_id: 'px', name: 'Docs', role: 'manager' },
      ],
    };
    expect(inviteLandingPath(accountInviteLanding({ account_id: described.account_id }, described))).toBe('/projects/pw');
    expect(inviteLandingPath(accountInviteLanding({ account_id: 'b', bootstrap_grants_applied: [] }, { projects: [] }))).toBe(
      '/projects/start?account=b',
    );
  });
});
