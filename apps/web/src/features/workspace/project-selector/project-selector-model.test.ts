import { describe, expect, test } from 'bun:test';

import type { KortixAccount, KortixProject, MyAccountInvite } from '@kortix/sdk';

import {
  accountNameStepAccount,
  buildAccountSections,
  countProjects,
  decideDoor,
  filterSections,
  joinDestination,
  type ProjectListResult,
} from './project-selector-model';

function account(id: string, role: KortixAccount['account_role'], name = `Account ${id}`): KortixAccount {
  return { account_id: id, name, account_role: role } as KortixAccount;
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

describe('buildAccountSections — one section per user state', () => {
  test('a member with project.create can create; an owner without it cannot', () => {
    const sections = buildAccountSections({ accounts: [account('member', 'member'), account('owner', 'owner')], lists: [list('member', []), list('owner', [])], creatableAccountIds: new Set(['member']) });
    expect(sections.find((s) => s.accountId === 'member')?.state).toBe('empty-creatable');
    expect(sections.find((s) => s.accountId === 'owner')?.state).toBe('empty-member');
  });

  test('new user: an owned account with no project is empty-creatable', () => {
    const sections = buildAccountSections({ creatableAccountIds: new Set(['a']), accounts: [account('a', 'owner')], lists: [list('a', [])] });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ state: 'empty-creatable', canCreate: true, projects: [] });
  });

  test('account member with no shared project is empty-member, never dropped', () => {
    const sections = buildAccountSections({ creatableAccountIds: new Set(['a']), accounts: [account('m', 'member')], lists: [list('m', [])] });
    expect(sections[0]).toMatchObject({ state: 'empty-member', canCreate: false });
  });

  test('project member sees exactly the granted projects under the owning account', () => {
    const sections = buildAccountSections({
      accounts: [account('m', 'member')],
      lists: [list('m', [project('p1', 'm')])],
    });
    expect(sections[0]).toMatchObject({ state: 'projects', canCreate: false });
    expect(sections[0].projects.map((p) => p.project_id)).toEqual(['p1']);
  });

  test('a failed list is its own state with no projects', () => {
    const sections = buildAccountSections({ creatableAccountIds: new Set(['a']), accounts: [account('a', 'admin')], lists: [list('a', undefined, true)] });
    expect(sections[0].state).toBe('failed');
  });

  test('archived projects are not offered', () => {
    const sections = buildAccountSections({
      accounts: [account('a', 'owner')],
      creatableAccountIds: new Set(['a']),
      lists: [list('a', [project('p1', 'a', { status: 'archived' })])],
    });
    expect(sections[0].state).toBe('empty-creatable');
  });

  test('projects sort most recently opened first; accounts sort by their latest project', () => {
    const sections = buildAccountSections({
      accounts: [account('old', 'owner'), account('new', 'member'), account('empty', 'owner')],
      lists: [
        list('old', [project('o1', 'old', { last_opened_at: '2026-09-01T00:00:00Z' })]),
        list('new', [
          project('n1', 'new', { last_opened_at: '2026-09-10T00:00:00Z' }),
          project('n2', 'new', { last_opened_at: '2026-09-20T00:00:00Z' }),
        ]),
        list('empty', []),
      ],
    });
    expect(sections.map((s) => s.accountId)).toEqual(['new', 'old', 'empty']);
    expect(sections[0].projects.map((p) => p.project_id)).toEqual(['n2', 'n1']);
  });

  test("a project in an account the user is not a member of still gets a section", () => {
    const sections = buildAccountSections({
      accounts: [account('a', 'owner')],
      lists: [list('a', [project('p1', 'a'), project('shared', 'foreign')])],
    });
    expect(sections.map((s) => s.accountId).sort()).toEqual(['a', 'foreign']);
    expect(countProjects(sections)).toBe(2);
  });

  test("the personal account's \"'s Account\" suffix is stripped", () => {
    const sections = buildAccountSections({
      accounts: [account('a', 'owner', "Marko's Account")],
      lists: [list('a', [])],
    });
    expect(sections[0].accountName).toBe('Marko');
  });
});

describe('filterSections', () => {
  const sections = buildAccountSections({
    accounts: [account('a', 'owner', 'Acme'), account('b', 'member', 'Beta')],
    lists: [
      list('a', [project('1', 'a', { name: 'Website' }), project('2', 'a', { name: 'Billing' })]),
      list('b', [project('3', 'b', { name: 'Research' })]),
    ],
  });

  test('matches project names case-insensitively', () => {
    const result = filterSections(sections, 'bill');
    expect(result.flatMap((s) => s.projects.map((p) => p.name))).toEqual(['Billing']);
  });

  test('an account-name match keeps every project in that account', () => {
    expect(filterSections(sections, 'beta').flatMap((s) => s.projects.map((p) => p.name))).toEqual(['Research']);
  });

  test('an empty query returns the input unchanged', () => {
    expect(filterSections(sections, '  ')).toBe(sections);
  });
});

describe('decideDoor — skip the selector only for one obvious answer', () => {
  const two = buildAccountSections({
    accounts: [account('a', 'owner')],
    lists: [list('a', [project('p1', 'a'), project('p2', 'a')])],
  });
  const one = buildAccountSections({ creatableAccountIds: new Set(['a']), accounts: [account('a', 'owner')], lists: [list('a', [project('p1', 'a')])] });
  const none = buildAccountSections({ creatableAccountIds: new Set(['a']), accounts: [account('a', 'owner')], lists: [list('a', [])] });

  test('the remembered project opens directly', () => {
    expect(decideDoor({ sections: two, inviteCount: 0, rememberedProjectId: 'p2' })).toEqual({
      kind: 'open',
      projectId: 'p2',
      accountId: 'a',
    });
  });

  test('a remembered project the user lost access to falls back to the selector', () => {
    expect(decideDoor({ sections: two, inviteCount: 0, rememberedProjectId: 'gone' })).toEqual({ kind: 'select' });
  });

  test('several projects and no memory show the selector', () => {
    expect(decideDoor({ sections: two, inviteCount: 0, rememberedProjectId: null })).toEqual({ kind: 'select' });
  });

  test('exactly one project opens directly', () => {
    expect(decideDoor({ sections: one, inviteCount: 0, rememberedProjectId: null }).kind).toBe('open');
  });

  test('a new user with no project gets the selector, never a form', () => {
    expect(decideDoor({ sections: none, inviteCount: 0, rememberedProjectId: null })).toEqual({ kind: 'select' });
  });

  test('a pending invite always shows the selector, even with a remembered project', () => {
    expect(decideDoor({ sections: one, inviteCount: 1, rememberedProjectId: 'p1' })).toEqual({ kind: 'select' });
  });
});

describe('joinDestination', () => {
  const base = {
    invite_id: 'i',
    account_id: 'a',
    account_name: 'Acme',
    initial_role: 'member',
    inviter_email: null,
    created_at: '',
    expires_at: '',
  } as unknown as MyAccountInvite;

  test('a project invite opens the first invited project', () => {
    expect(joinDestination({ ...base, projects: [{ project_id: 'p1', name: 'X', role: 'member' }] } as MyAccountInvite)).toBe(
      '/projects/p1',
    );
  });

  test('a workspace invite has no direct destination', () => {
    expect(joinDestination({ ...base, projects: [] } as MyAccountInvite)).toBeNull();
  });
});

describe('accountNameStepAccount — the onboarding name step (KRTX-638)', () => {
  const USER = 'u1';
  const fresh = () =>
    buildAccountSections({ creatableAccountIds: new Set([USER]), accounts: [account(USER, 'owner', "Ada's workspace")], lists: [list(USER, [])] });

  test('a brand-new user is asked to name their personal account', () => {
    expect(
      accountNameStepAccount({ sections: fresh(), inviteCount: 0, userId: USER, namedAt: null }),
    ).toMatchObject({ accountId: USER, accountName: "Ada's workspace" });
  });

  test('never again once they have named it', () => {
    expect(
      accountNameStepAccount({
        sections: fresh(),
        inviteCount: 0,
        userId: USER,
        namedAt: '2026-09-29T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  test('not a new user: any project in any account skips the step', () => {
    const sections = buildAccountSections({
      accounts: [account(USER, 'owner'), account('team', 'member')],
      lists: [list(USER, []), list('team', [project('p1', 'team')])],
    });
    expect(accountNameStepAccount({ sections, inviteCount: 0, userId: USER, namedAt: null })).toBeNull();
  });

  test('someone joining through an invite is not setting up an account', () => {
    expect(
      accountNameStepAccount({ sections: fresh(), inviteCount: 1, userId: USER, namedAt: null }),
    ).toBeNull();
  });

  test('a failed project list is not an empty one', () => {
    const sections = buildAccountSections({
      accounts: [account(USER, 'owner')],
      lists: [list(USER, undefined, true)],
    });
    expect(accountNameStepAccount({ sections, inviteCount: 0, userId: USER, namedAt: null })).toBeNull();
  });

  test('only the user\'s OWN personal account is ever renamed here', () => {
    const sections = buildAccountSections({
      accounts: [account('someone-else', 'owner')],
      lists: [list('someone-else', [])],
    });
    expect(accountNameStepAccount({ sections, inviteCount: 0, userId: USER, namedAt: null })).toBeNull();
  });
});
