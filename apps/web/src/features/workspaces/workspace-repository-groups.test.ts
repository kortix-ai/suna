import { describe, expect, test } from 'bun:test';

import type { KortixWorkspace } from '@kortix/sdk';
import { groupWorkspacesByRepository } from './workspace-repository-groups';

function workspace(workspaceId: string, repoUrl: string, branch: string): KortixWorkspace {
  return {
    workspace_id: workspaceId,
    account_id: 'account-1',
    name: workspaceId,
    repo_url: repoUrl,
    default_branch: branch,
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('groupWorkspacesByRepository', () => {
  test('groups equivalent GitHub URLs while preserving isolated workspaces and branches', () => {
    const groups = groupWorkspacesByRepository([
      workspace('API dev', 'https://github.com/Kortix/suna.git', 'dev'),
      workspace('Web dev', 'git@github.com:kortix/suna.git', 'dev'),
      workspace('Production', 'https://github.com/kortix/suna/', 'main'),
      workspace('Company', 'https://github.com/kortix/company.git', 'main'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      key: 'github.com/kortix/suna',
      label: 'Kortix/suna',
    });
    expect(groups[0]?.workspaces.map((item) => [item.name, item.default_branch])).toEqual([
      ['API dev', 'dev'],
      ['Web dev', 'dev'],
      ['Production', 'main'],
    ]);
    expect(groups[1]?.label).toBe('kortix/company');
  });
});
