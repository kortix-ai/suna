import { describe, expect, test } from 'bun:test';

import type { KortixProject } from '@kortix/sdk';
import { groupProjectsByRepository } from './project-repository-groups';

function project(projectId: string, repoUrl: string, branch: string): KortixProject {
  return {
    project_id: projectId,
    account_id: 'account-1',
    name: projectId,
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

describe('groupProjectsByRepository', () => {
  test('groups equivalent GitHub URLs while preserving isolated projects and branches', () => {
    const groups = groupProjectsByRepository([
      project('API dev', 'https://github.com/Kortix/suna.git', 'dev'),
      project('Web dev', 'git@github.com:kortix/suna.git', 'dev'),
      project('Production', 'https://github.com/kortix/suna/', 'main'),
      project('Company', 'https://github.com/kortix/company.git', 'main'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      key: 'github.com/kortix/suna',
      label: 'Kortix/suna',
    });
    expect(groups[0]?.projects.map((item) => [item.name, item.default_branch])).toEqual([
      ['API dev', 'dev'],
      ['Web dev', 'dev'],
      ['Production', 'main'],
    ]);
    expect(groups[1]?.label).toBe('kortix/company');
  });
});
