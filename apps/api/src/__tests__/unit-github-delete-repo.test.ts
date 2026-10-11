/**
 * Deleting a managed GitHub repo that is already gone is the state the delete
 * produces, not a failure (KRTX-1734): an archived project keeps its managed
 * connection after DELETE /projects removed the repo, and account erasure
 * deletes it again. Any other GitHub failure still throws, so the run retries.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { GitHubApiError } from '../projects/github-http';

let answer: GitHubApiError | null = null;
const deleted: string[] = [];

const realBackendConfig = await import('../platform/services/managed-git-backend');
mock.module('../platform/services/managed-git-backend', () => ({
  ...realBackendConfig,
  resolveGitBackend: () => ({ kind: 'pat', owner: 'managed-org', token: 'ghp_test' }),
}));
const realGithub = await import('../projects/github');
mock.module('../projects/github', () => ({
  ...realGithub,
  isOrgAccount: async () => true,
  deleteRepo: async (input: { owner: string; repo: string }) => {
    if (answer) throw answer;
    deleted.push(`${input.owner}/${input.repo}`);
  },
}));

const { githubBackend } = await import('../projects/git-backends/github');

const ref = {
  provider: 'github',
  upstreamUrl: 'https://github.com/managed-org/repo-a.git',
  externalRepoId: null,
  repoOwner: 'managed-org',
  repoName: 'repo-a',
  installationId: null,
  credentialRef: null,
  defaultBranch: 'main',
  managed: true,
  metadata: {},
};

beforeEach(() => {
  answer = null;
  deleted.length = 0;
});

describe('githubBackend.deleteRepo', () => {
  test('deletes the repo', async () => {
    await githubBackend.deleteRepo(ref);
    expect(deleted).toEqual(['managed-org/repo-a']);
  });

  test('a repo GitHub no longer has (404) counts as deleted', async () => {
    answer = new GitHubApiError('Not Found', 404, '/repos/managed-org/repo-a');
    await expect(githubBackend.deleteRepo(ref)).resolves.toBeUndefined();
  });

  test('any other GitHub failure still throws', async () => {
    answer = new GitHubApiError('Server Error', 502, '/repos/managed-org/repo-a');
    await expect(githubBackend.deleteRepo(ref)).rejects.toThrow('Server Error');
  });
});
