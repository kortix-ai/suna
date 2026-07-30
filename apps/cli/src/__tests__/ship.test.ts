import { describe, expect, test } from 'bun:test';

import type { ApiClient } from '../api/client.ts';
import type { ProjectSummary } from '../api/types.ts';
import {
  authHeaderArgs,
  linkGitHubBackedProject,
  reconcileShippedManifest,
  resolveExistingShipGitTarget,
  resolveProvisionShipGitTarget,
} from '../commands/ship.ts';
import { resolveProjectCloneTarget } from '../commands/projects.ts';

test('managed git auth headers honor the provider-selected username', () => {
  const args = authHeaderArgs('https://kortix.code.storage/demo.git', 'jwt-token', 't');
  expect(args.at(-1)).toStartWith(
    'http.https://kortix.code.storage/.extraheader=Authorization: Basic ',
  );
  const encoded = args.at(-1)?.split('Authorization: Basic ')[1];
  expect(encoded && Buffer.from(encoded, 'base64').toString('utf8')).toBe('t:jwt-token');
});

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project_id: 'proj_1',
    account_id: 'acct_1',
    name: 'Demo',
    repo_url: 'https://github.com/managed-kortix/demo.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function recordingClient(
  calls: Array<{ path: string; body: unknown }>,
  linkedProject: ProjectSummary,
): ApiClient {
  return {
    apiBase: 'https://api.kortix.test',
    post: async <T>(path: string, body?: unknown) => {
      calls.push({ path, body });
      return { project: linkedProject } as T;
    },
  } as unknown as ApiClient;
}

describe('GitHub-backed project linking', () => {
  test('uses the projects-mounted route with a GitHub PAT', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];

    await linkGitHubBackedProject(recordingClient(calls, project()), {
      repoUrl: 'https://github.com/acme/demo.git',
      name: 'Demo',
      accountId: 'acct_1',
      githubToken: 'github_pat_test',
      yes: true,
    });

    expect(calls).toEqual([
      {
        path: '/projects/link-repository',
        body: {
          repo_url: 'https://github.com/acme/demo.git',
          name: 'Demo',
          account_id: 'acct_1',
          github_token: 'github_pat_test',
        },
      },
    ]);
  });

  test('uses the projects-mounted route with the GitHub App', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];

    await linkGitHubBackedProject(recordingClient(calls, project()), {
      repoUrl: 'https://github.com/acme/demo.git',
      name: 'Demo',
      accountId: 'acct_1',
      yes: true,
    });

    expect(calls).toEqual([
      {
        path: '/projects/link-repository',
        body: {
          repo_url: 'https://github.com/acme/demo.git',
          name: 'Demo',
          account_id: 'acct_1',
        },
      },
    ]);
  });
});

describe('ship git target resolution', () => {
  // A host whose managed git runs on an org-wide PAT cannot export a push token
  // at all (POST /git-token 503s — the token would grant write to every managed
  // repo). Ship must therefore prefer the proxy origin for MANAGED projects
  // too, exactly like clone does; insisting on a minted provider token is what
  // broke `kortix ship` against Kortix Cloud.
  test('first-time managed ship pushes through the proxy origin, not the raw upstream', () => {
    const target = resolveProvisionShipGitTarget({
      ...project({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
      push_token: 'ghp_push',
      repo_id: 'repo_1',
    });

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('existing managed ship pushes through the proxy origin', () => {
    const target = resolveExistingShipGitTarget(
      project({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('managed ship falls back to a minted token when the host has no proxy', () => {
    // Proxy off ⇒ the server mirrors repo_url into git_origin_url.
    const raw = 'https://github.com/managed-kortix/demo.git';
    const target = resolveExistingShipGitTarget(
      project({ git_origin_url: raw, metadata: { git: { managed: true } } }),
    );

    expect(target).toEqual({ repoUrl: raw, credentialMode: 'managed-git-token' });
  });

  test('first-time managed ship on a proxy-less host mints a provider token', () => {
    const target = resolveProvisionShipGitTarget({
      ...project({ metadata: { git: { managed: true } } }),
      push_token: 'ghp_push',
      repo_id: 'repo_1',
    });

    expect(target).toEqual({
      repoUrl: 'https://github.com/managed-kortix/demo.git',
      credentialMode: 'managed-git-token',
    });
  });

  test('non-managed proxy projects still push through the Kortix git proxy', () => {
    const target = resolveExistingShipGitTarget(
      project({
        repo_url: 'https://github.com/acme/byo.git',
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: false } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('plain BYO projects rely on local git credentials', () => {
    const target = resolveExistingShipGitTarget(
      project({
        repo_url: 'https://github.com/acme/byo.git',
        metadata: { git: { managed: false } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://github.com/acme/byo.git',
      credentialMode: 'none',
    });
  });

  // The regression this whole module exists to prevent: ship and clone drifted
  // apart and ship picked a credential the server can't issue. They resolve
  // from the same function now — assert they agree on every project shape.
  test('ship and clone resolve the same repo URL for every project shape', () => {
    const proxy = 'https://api.kortix.com/v1/git/proj_1.git';
    const shapes: ProjectSummary[] = [
      project({ git_origin_url: proxy, metadata: { git: { managed: true } } }),
      project({ git_origin_url: proxy, metadata: { git: { managed: false } } }),
      project({ metadata: { git: { managed: true } } }),
      project({ repo_url: 'https://github.com/acme/byo.git', metadata: {} }),
    ];

    for (const shape of shapes) {
      const ship = resolveExistingShipGitTarget(shape);
      const clone = resolveProjectCloneTarget(shape, 'kortix_pat_abc');
      expect(clone.repoUrl).toBe(ship.repoUrl);
      expect(clone.needsManagedToken).toBe(ship.credentialMode === 'managed-git-token');
      expect(clone.token).toBe(ship.credentialMode === 'kortix-token' ? 'kortix_pat_abc' : null);
    }
  });
});

test('ship reconciles the remote manifest independently of connector prompts', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = recordingClient(calls, project());

  await reconcileShippedManifest(client, 'proj_1');

  expect(calls).toEqual([
    {
      path: '/executor/projects/proj_1/connectors/sync',
      body: undefined,
    },
  ]);
});
