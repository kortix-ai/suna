import { describe, expect, test } from 'bun:test';

import {
  filterWorkspaceGroups,
  groupWorkspacesByAccount,
  resolveSwitcherAccountId,
  resolveWorkspaceRowNavigation,
} from './workspace-grouping';

const account = (accountId: string, name: string) => ({ account_id: accountId, name });

const workspace = (
  projectId: string,
  accountId: string,
  name: string,
  lastOpenedAt: string | null,
) => ({
  project_id: projectId,
  account_id: accountId,
  name,
  last_opened_at: lastOpenedAt,
  repo_url: 'https://example.test/repo',
  default_branch: 'main',
  manifest_path: 'kortix.yaml',
  status: 'active' as const,
  metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

describe('groupWorkspacesByAccount', () => {
  test("puts the active workspace's account first, then the rest alphabetically", () => {
    const groups = groupWorkspacesByAccount({
      accounts: [
        account('a-zebra', 'Zebra'),
        account('a-acme', 'Acme'),
        account('a-kortix', 'Kortix'),
      ],
      workspaces: [
        workspace('p1', 'a-zebra', 'zebra-one', null),
        workspace('p2', 'a-acme', 'acme-one', null),
        workspace('p3', 'a-kortix', 'kortix-one', null),
      ],
      activeWorkspaceId: 'p3',
    });

    expect(groups.map((g) => g.accountName)).toEqual(['Kortix', 'Acme', 'Zebra']);
  });

  test('sorts workspaces inside a group by last_opened_at, most recent first', () => {
    const groups = groupWorkspacesByAccount({
      accounts: [account('a1', 'Kortix')],
      workspaces: [
        workspace('old', 'a1', 'older', '2026-01-01T00:00:00.000Z'),
        workspace('new', 'a1', 'newer', '2026-06-01T00:00:00.000Z'),
        workspace('never', 'a1', 'never-opened', null),
      ],
      activeWorkspaceId: null,
    });

    expect(groups[0].workspaces.map((w) => w.project_id)).toEqual(['new', 'old', 'never']);
  });

  test('falls back to alphabetical account order when nothing is active', () => {
    const groups = groupWorkspacesByAccount({
      accounts: [account('a-zebra', 'Zebra'), account('a-acme', 'Acme')],
      workspaces: [workspace('p1', 'a-zebra', 'z', null), workspace('p2', 'a-acme', 'a', null)],
      activeWorkspaceId: null,
    });

    expect(groups.map((g) => g.accountName)).toEqual(['Acme', 'Zebra']);
  });

  test('drops accounts that have no workspaces', () => {
    const groups = groupWorkspacesByAccount({
      accounts: [account('a1', 'Kortix'), account('a2', 'Empty')],
      workspaces: [workspace('p1', 'a1', 'one', null)],
      activeWorkspaceId: null,
    });

    expect(groups.map((g) => g.accountId)).toEqual(['a1']);
  });

  test('keeps workspaces whose account is not in the accounts list, under their id', () => {
    const groups = groupWorkspacesByAccount({
      accounts: [],
      workspaces: [workspace('p1', 'a-orphan', 'orphan', null)],
      activeWorkspaceId: null,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].accountId).toBe('a-orphan');
    expect(groups[0].accountName).toBe('Account');
  });

  test('an unnamed account still gets a stable label', () => {
    const groups = groupWorkspacesByAccount({
      accounts: [{ account_id: 'a1', name: '' }],
      workspaces: [workspace('p1', 'a1', 'one', null)],
      activeWorkspaceId: null,
    });

    expect(groups[0].accountName).toBe('Account');
  });
});

describe('resolveSwitcherAccountId', () => {
  const accounts = [account('a-first', 'First'), account('a-other', 'Other')];
  const workspaces = [
    workspace('p1', 'a-first', 'one', null),
    workspace('p2', 'a-other', 'two', null),
  ];

  test("prefers the open workspace's account over the stored selection", () => {
    expect(
      resolveSwitcherAccountId({
        accounts,
        workspaces,
        activeWorkspaceId: 'p2',
        selectedAccountId: 'a-first',
      }),
    ).toBe('a-other');
  });

  test('falls back to the stored selection when no workspace is open', () => {
    expect(
      resolveSwitcherAccountId({
        accounts,
        workspaces,
        activeWorkspaceId: null,
        selectedAccountId: 'a-other',
      }),
    ).toBe('a-other');
  });

  test('falls back to the first account when nothing is selected yet', () => {
    expect(
      resolveSwitcherAccountId({
        accounts,
        workspaces,
        activeWorkspaceId: null,
        selectedAccountId: null,
      }),
    ).toBe('a-first');
  });

  test('an active id with no matching workspace still resolves, not crashes', () => {
    expect(
      resolveSwitcherAccountId({
        accounts,
        workspaces,
        activeWorkspaceId: 'p-unknown',
        selectedAccountId: 'a-other',
      }),
    ).toBe('a-other');
  });

  test('null while the accounts are genuinely unknown — never `/accounts/null`', () => {
    expect(
      resolveSwitcherAccountId({
        accounts: [],
        workspaces: [],
        activeWorkspaceId: null,
        selectedAccountId: null,
      }),
    ).toBeNull();
  });
});

describe('resolveWorkspaceRowNavigation', () => {
  const active = workspace('p-active', 'a1', 'active', null);
  const other = workspace('p-other', 'a2', 'other', null);

  test('the already-active row opens ITS account settings, not a switch', () => {
    expect(resolveWorkspaceRowNavigation(active, 'p-active')).toEqual({
      kind: 'account-settings',
      href: '/accounts/a1',
    });
  });

  test('every other row still switches to that workspace', () => {
    expect(resolveWorkspaceRowNavigation(other, 'p-active')).toEqual({
      kind: 'switch',
      href: '/projects/p-other',
    });
  });

  test('with no active workspace every row switches', () => {
    expect(resolveWorkspaceRowNavigation(active, null).kind).toBe('switch');
    expect(resolveWorkspaceRowNavigation(active, undefined).kind).toBe('switch');
  });
});

describe('filterWorkspaceGroups', () => {
  const groups = [
    {
      accountId: 'a1',
      accountName: 'Kortix',
      workspaces: [
        workspace('p1', 'a1', 'suna-web', null),
        workspace('p2', 'a1', 'kortix-api', null),
      ],
    },
    {
      accountId: 'a2',
      accountName: 'Acme',
      workspaces: [workspace('p3', 'a2', 'acme-agent', null)],
    },
  ];

  test('an empty query returns every group untouched', () => {
    expect(filterWorkspaceGroups(groups, '')).toEqual(groups);
    expect(filterWorkspaceGroups(groups, '   ')).toEqual(groups);
  });

  test('matches workspace names case-insensitively', () => {
    const result = filterWorkspaceGroups(groups, 'SUNA');
    expect(result).toHaveLength(1);
    expect(result[0].workspaces.map((w) => w.name)).toEqual(['suna-web']);
  });

  test('matches the account name too, keeping all its workspaces', () => {
    const result = filterWorkspaceGroups(groups, 'acme');
    expect(result).toHaveLength(1);
    expect(result[0].accountName).toBe('Acme');
    expect(result[0].workspaces).toHaveLength(1);
  });

  test('drops groups with no surviving workspaces', () => {
    expect(filterWorkspaceGroups(groups, 'nothing-matches-this')).toEqual([]);
  });

  test('never truncates — 200 matching workspaces all survive', () => {
    const many = Array.from({ length: 200 }, (_, i) => workspace(`p${i}`, 'a1', `ws-${i}`, null));
    const result = filterWorkspaceGroups(
      [{ accountId: 'a1', accountName: 'Kortix', workspaces: many }],
      'ws-',
    );
    expect(result[0].workspaces).toHaveLength(200);
  });
});
