import { describe, expect, mock, test } from 'bun:test';
import { deleteManagedProjectRepo } from '../projects/lib/project-deletion';

const project = {
  projectId: '00000000-0000-4000-a000-000000000201',
  accountId: '00000000-0000-4000-a000-000000000101',
  name: 'Managed project',
  repoUrl: 'https://kortix.code.storage/managed-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  status: 'active',
  metadata: {
    git: {
      provider: 'code-storage',
      managed: true,
      auth: { method: 'managed' },
      upstream_url: 'https://kortix.code.storage/managed-project.git',
      repo_id: 'repo-1',
      name: 'managed-project',
    },
  },
} as any;

describe('deleteManagedProjectRepo', () => {
  test('deletes a managed repository through its configured backend', async () => {
    const deleteRepo = mock(async (_ref: any) => undefined);

    const deleted = await deleteManagedProjectRepo(project, {
      getConnection: async () => null,
      getBackend: () => ({ deleteRepo }) as any,
    });

    expect(deleted).toBe(true);
    expect(deleteRepo).toHaveBeenCalledTimes(1);
    expect(deleteRepo.mock.calls[0]?.[0]).toMatchObject({
      provider: 'code-storage',
      repoName: 'managed-project',
      externalRepoId: 'repo-1',
      managed: true,
    });
  });

  test('leaves user-connected repositories untouched', async () => {
    const deleteRepo = mock(async (_ref: any) => undefined);
    const byo = {
      ...project,
      metadata: {
        git: {
          ...(project.metadata.git as Record<string, unknown>),
          managed: false,
          auth: { method: 'github_app' },
        },
      },
    };

    const deleted = await deleteManagedProjectRepo(byo, {
      getConnection: async () => null,
      getBackend: () => ({ deleteRepo }) as any,
    });

    expect(deleted).toBe(false);
    expect(deleteRepo).not.toHaveBeenCalled();
  });
});
