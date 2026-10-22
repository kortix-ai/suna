/**
 * `managed` on a git connection means "this repository lives in the Kortix
 * managed-git backend". Auth, deletion, push credentials and collaborator
 * invites all branch on it through `getProjectGitRemote`.
 *
 * `POST /projects/create-repo` used to write `managed: true` for a repository
 * it created in the ACCOUNT's own GitHub. With a managed-org PAT configured
 * (production sets one), the mirror then cloned that repository with the PAT,
 * GitHub answered `Repository not found`, and the first session failed with
 * `503 git_mirror_unavailable`. Those rows exist; this reads them correctly.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { getProjectGitRemote } from './git';

const ENV_KEYS = [
  'MANAGED_GIT_GITHUB_OWNER',
  'MANAGED_GIT_GITHUB_TOKEN',
  'MANAGED_GIT_GITHUB_INSTALL_ID',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function connection(overrides: Record<string, unknown>) {
  return {
    provider: 'github',
    authMethod: 'github_app',
    credentialRef: null,
    installationId: null,
    repoOwner: 'managed-org',
    repoName: 'repo',
    externalRepoId: '1',
    upstreamUrl: null,
    managed: true,
    ...overrides,
  } as never;
}

const PROJECT = { projectId: 'p', repoUrl: '', metadata: {} } as never;

describe('getProjectGitRemote: managed means the managed backend', () => {
  test('a create-repo row under the account installation and owner is not managed', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-org';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'managed-pat';
    const remote = getProjectGitRemote(
      PROJECT,
      connection({ installationId: '165', repoOwner: 'octo-person' }),
    );
    expect(remote.managed).toBe(false);
  });

  test('the same row from project metadata alone is not managed', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-org';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'managed-pat';
    const remote = getProjectGitRemote({
      projectId: 'p',
      repoUrl: 'https://github.com/octo-person/repo.git',
      metadata: {
        git: {
          provider: 'github',
          managed: true,
          owner: 'octo-person',
          name: 'repo',
          auth: { method: 'github_app', installation_id: '165' },
        },
      },
    } as never);
    expect(remote.managed).toBe(false);
  });

  test('a PAT-backend managed repo (no installation) stays managed', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-org';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'managed-pat';
    expect(getProjectGitRemote(PROJECT, connection({})).managed).toBe(true);
  });

  test('an App-backend managed repo on the managed installation stays managed', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-org';
    process.env.MANAGED_GIT_GITHUB_INSTALL_ID = '900';
    delete process.env.MANAGED_GIT_GITHUB_TOKEN;
    expect(getProjectGitRemote(PROJECT, connection({ installationId: '900' })).managed).toBe(true);
  });

  // A backend switched from App to PAT keeps its old repos: same owner, old
  // installation id. The owner still matches, so they stay managed.
  test('a managed-owner repo on an old installation stays managed', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'Managed-Org';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'managed-pat';
    expect(getProjectGitRemote(PROJECT, connection({ installationId: '900' })).managed).toBe(true);
  });

  test('with no managed backend configured the stored flag is kept', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const remote = getProjectGitRemote(
      PROJECT,
      connection({ installationId: '165', repoOwner: 'octo-person' }),
    );
    expect(remote.managed).toBe(true);
  });

  test('a row stored as not managed is never promoted', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-org';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'managed-pat';
    expect(getProjectGitRemote(PROJECT, connection({ managed: false })).managed).toBe(false);
  });
});
