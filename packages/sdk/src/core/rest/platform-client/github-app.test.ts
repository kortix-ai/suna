import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { type GitHubAppStatus, getGitHubAppStatus } from './github-app';

configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });

let calls: string[] = [];

beforeEach(() => {
  calls = [];
});

function respond(status: GitHubAppStatus) {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Response.json(status);
  }) as unknown as typeof fetch;
}

test('reports which source owns the instance identity and backend', async () => {
  respond({
    configured: true,
    owner: 'managed-kortix',
    slug: 'kortix-managed',
    installation_id: '140097279',
    source: 'env',
    oauth_configured: true,
    identity_source: 'env',
    backend_source: 'env',
    mutable: false,
    install_url: 'https://github.com/apps/kortix-managed/installations/new',
    env_owned_by: ['KORTIX_GITHUB_APP_ID', 'MANAGED_GIT_GITHUB_TOKEN'],
  } satisfies GitHubAppStatus);

  const status = await getGitHubAppStatus();

  expect(calls[0]).toBe('http://backend.local/v1/platform/github-app/status');
  expect(status.identity_source).toBe('env');
  expect(status.backend_source).toBe('env');
  expect(status.mutable).toBe(false);
  expect(status.env_owned_by).toEqual(['KORTIX_GITHUB_APP_ID', 'MANAGED_GIT_GITHUB_TOKEN']);
  expect(status.install_url).toBe('https://github.com/apps/kortix-managed/installations/new');
});

test('reports a mutable instance when neither half is env-managed', async () => {
  respond({
    configured: false,
    owner: null,
    slug: null,
    installation_id: null,
    source: 'none',
    oauth_configured: false,
    identity_source: 'none',
    backend_source: 'none',
    mutable: true,
    install_url: null,
    env_owned_by: [],
  } satisfies GitHubAppStatus);

  const status = await getGitHubAppStatus();

  expect(status.mutable).toBe(true);
  expect(status.identity_source).toBe('none');
  expect(status.backend_source).toBe('none');
  expect(status.install_url).toBeNull();
  expect(status.env_owned_by).toEqual([]);
});
