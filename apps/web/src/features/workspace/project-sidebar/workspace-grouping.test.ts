import { describe, expect, test } from 'bun:test';

import { groupWorkspacesByAccount } from './workspace-grouping';

const account = (accountId: string, name: string) => ({ account_id: accountId, name });

const workspace = (projectId: string, accountId: string, name: string, lastOpenedAt: string | null) =>
  ({
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
      accounts: [account('a-zebra', 'Zebra'), account('a-acme', 'Acme'), account('a-kortix', 'Kortix')],
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
