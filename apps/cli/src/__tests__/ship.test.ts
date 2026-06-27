import { describe, expect, test } from 'bun:test';

import {
  resolveExistingShipGitTarget,
  resolveProvisionShipGitTarget,
} from '../commands/ship.ts';
import type { ProjectSummary } from '../api/types.ts';

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project_id: 'proj_1',
    account_id: 'acct_1',
    name: 'Demo',
    repo_url: 'https://github.com/managed-kortix/demo.git',
    default_branch: 'main',
    manifest_path: 'kortix.toml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ship git target resolution', () => {
  test('first-time managed ship pushes to the managed upstream with the provision token', () => {
    const target = resolveProvisionShipGitTarget({
      ...project({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
      push_token: 'ghp_push',
      repo_id: 'repo_1',
    });

    expect(target).toEqual({
      repoUrl: 'https://github.com/managed-kortix/demo.git',
      credentialMode: 'managed-git-token',
    });
  });

  test('existing managed ship ignores proxy origin and mints a managed git token', () => {
    const target = resolveExistingShipGitTarget(project({
      git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
      metadata: { git: { managed: true } },
    }));

    expect(target).toEqual({
      repoUrl: 'https://github.com/managed-kortix/demo.git',
      credentialMode: 'managed-git-token',
    });
  });

  test('non-managed proxy projects still push through the Kortix git proxy', () => {
    const target = resolveExistingShipGitTarget(project({
      repo_url: 'https://github.com/acme/byo.git',
      git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
      metadata: { git: { managed: false } },
    }));

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('plain BYO projects rely on local git credentials', () => {
    const target = resolveExistingShipGitTarget(project({
      repo_url: 'https://github.com/acme/byo.git',
      metadata: { git: { managed: false } },
    }));

    expect(target).toEqual({
      repoUrl: 'https://github.com/acme/byo.git',
      credentialMode: 'none',
    });
  });
});
