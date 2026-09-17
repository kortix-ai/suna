import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type ManagedGitBackend,
  type ManagedGitRepositoriesResponse,
  getManagedGitBackend,
  listManagedGitRepositories,
} from './git-backend';

configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });

let calls: string[] = [];

beforeEach(() => {
  calls = [];
});

function respond(body: unknown) {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Response.json(body);
  }) as unknown as typeof fetch;
}

test('reads the instance git backend without naming its credential', async () => {
  respond({ configured: true, kind: 'pat', owner: 'managed-kortix' } satisfies ManagedGitBackend);

  const backend = await getManagedGitBackend();

  expect(calls[0]).toBe('http://backend.local/v1/projects/git/backend');
  expect(backend).toEqual({ configured: true, kind: 'pat', owner: 'managed-kortix' });
});

test('reports an unconfigured instance git backend', async () => {
  respond({ configured: false, kind: null, owner: null } satisfies ManagedGitBackend);

  const backend = await getManagedGitBackend();

  expect(backend.configured).toBe(false);
  expect(backend.kind).toBeNull();
  expect(backend.owner).toBeNull();
});

test('lists instance backend repositories under their own namespace', async () => {
  respond({
    owner: 'managed-kortix',
    repositories: [
      {
        id: '1',
        name: 'portal',
        full_name: 'managed-kortix/portal',
        private: true,
        html_url: 'https://github.com/managed-kortix/portal',
        clone_url: 'https://github.com/managed-kortix/portal.git',
        ssh_url: 'git@github.com:managed-kortix/portal.git',
        default_branch: 'main',
        description: null,
      },
    ],
  } satisfies ManagedGitRepositoriesResponse);

  const result = await listManagedGitRepositories({ search: 'port al', limit: 25 });

  expect(calls[0]).toBe(
    'http://backend.local/v1/projects/git/backend/repositories?search=port+al&limit=25',
  );
  expect(result.owner).toBe('managed-kortix');
  expect(result.repositories[0]?.full_name).toBe('managed-kortix/portal');
});

test('omits empty search and limit parameters', async () => {
  respond({ owner: 'managed-kortix', repositories: [] } satisfies ManagedGitRepositoriesResponse);

  await listManagedGitRepositories();

  expect(calls[0]).toBe('http://backend.local/v1/projects/git/backend/repositories');
});
