import { describe, expect, test } from 'bun:test';
import type { GitHubRepo } from '../projects/github';
import { githubRepositoryCreatePath } from '../projects/github';
import { validateNangoRepositoryImport } from '../projects/nango/repository-operations';

function nangoRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    id: 901,
    name: 'console',
    full_name: 'acme/console',
    private: true,
    html_url: 'https://github.com/acme/console',
    clone_url: 'https://github.com/acme/console.git',
    ssh_url: 'git@github.com:acme/console.git',
    default_branch: 'main',
    description: null,
    permissions: { push: true },
    ...overrides,
  };
}

describe('Nango GitHub repository import validation', () => {
  test('revalidates repository ID, owner, name, branch, and write permission', async () => {
    const branchRequests: string[] = [];
    const result = await validateNangoRepositoryImport(
      {
        expectedOwner: 'acme',
        expectedName: 'console',
        expectedRepositoryId: '901',
        requestedBranch: 'release',
        repo: nangoRepo(),
      },
      {
        getBranch: async ({ branch }) => {
          branchRequests.push(branch);
          return { name: branch, protected: false };
        },
      },
    );

    expect(result.defaultBranch).toBe('release');
    expect(branchRequests).toEqual(['release']);
  });

  test('rejects a transferred repository, stale ID, deleted branch, and read-only access', async () => {
    const base = {
      expectedOwner: 'acme',
      expectedName: 'console',
      expectedRepositoryId: '901',
      requestedBranch: null,
    };
    const getBranch = async () => ({ name: 'main', protected: false });

    await expect(
      validateNangoRepositoryImport(
        { ...base, repo: nangoRepo({ full_name: 'globex/console' }) },
        { getBranch },
      ),
    ).rejects.toMatchObject({ code: 'github_repository_not_found', status: 404 });
    await expect(
      validateNangoRepositoryImport(
        { ...base, expectedRepositoryId: '902', repo: nangoRepo() },
        { getBranch },
      ),
    ).rejects.toMatchObject({ code: 'github_repository_not_found' });
    await expect(
      validateNangoRepositoryImport(
        { ...base, requestedBranch: 'deleted', repo: nangoRepo() },
        { getBranch: async () => { throw Object.assign(new Error('Not found'), { status: 404 }); } },
      ),
    ).rejects.toMatchObject({ code: 'github_repository_not_found' });
    await expect(
      validateNangoRepositoryImport(
        { ...base, repo: nangoRepo({ permissions: { push: false } }) },
        { getBranch },
      ),
    ).rejects.toMatchObject({ code: 'github_insufficient_permissions', status: 403 });
  });
});

describe('Nango GitHub repository creation routing', () => {
  test.each([
    ['User', 'octocat', '/user/repos'],
    ['Organization', 'acme', '/orgs/acme/repos'],
  ] as const)('selects %s creation endpoint', (ownerType, owner, expectedPath) => {
    expect(githubRepositoryCreatePath({ owner, ownerType })).toBe(expectedPath);
  });
});
