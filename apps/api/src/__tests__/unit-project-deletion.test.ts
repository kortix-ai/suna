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

  test('leaves a shared managed repository untouched when another project owns deletion', async () => {
    const deleteRepo = mock(async (_ref: any) => undefined);
    const shared = {
      ...project,
      metadata: {
        git: {
          ...(project.metadata.git as Record<string, unknown>),
          managed: false,
          auth: { method: 'managed_shared' },
        },
        repository_source_project_id: '00000000-0000-4000-a000-000000000999',
      },
    };

    const deleted = await deleteManagedProjectRepo(shared, {
      getConnection: async () =>
        ({
          provider: 'code-storage',
          repoUrl: shared.repoUrl,
          upstreamUrl: shared.repoUrl,
          managed: false,
          repoOwner: null,
          repoName: 'managed-project',
          externalRepoId: 'repo-1',
          defaultBranch: 'ke2e-run-1',
          authMethod: 'managed_shared',
          installationId: null,
          credentialRef: null,
          metadata: {
            shared_repository_owner_project_id: '00000000-0000-4000-a000-000000000999',
          },
        }) as any,
      getBackend: () => ({ deleteRepo }) as any,
    });

    expect(deleted).toBe(false);
    expect(deleteRepo).not.toHaveBeenCalled();
  });
});
