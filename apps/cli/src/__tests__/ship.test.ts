import { describe, expect, test } from 'bun:test';

import type { ApiClient } from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type { ProjectSummary } from '../api/types.ts';
import {
  authHeaderArgs,
  isManagedTokenExportUnavailable,
  linkGitHubBackedProject,
  reconcileShippedManifest,
  resolveExistingShipGitTarget,
  resolveManagedProxyFallback,
  resolveManagedPushPlan,
  resolveProvisionShipGitTarget,
} from '../commands/ship.ts';

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

describe('managed push plan (host cannot export a repo-scoped token)', () => {
  const managed = () =>
    project({
      git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
      metadata: { git: { managed: true } },
    });

  function failingClient(status: number, message: string, calls: string[] = []) {
    return {
      post: async <T>(path: string) => {
        calls.push(path);
        throw new ApiError(status, message);
      },
    } as unknown as Pick<ApiClient, 'post'>;
  }

  test('reproduces the reported failure: 503 on /git-token used to abort the ship', async () => {
    // Before the fix this rejected and `kortix ship` exited 1 with
    // "Managed git push token export requires a repo-scoped installation token".
    const noProxy = { project_id: 'proj_1', repo_url: 'https://github.com/managed-kortix/demo.git' };
    await expect(
      resolveManagedPushPlan(
        failingClient(503, 'Managed git push token export requires a repo-scoped installation token'),
        noProxy,
        'kortix-jwt',
      ),
    ).rejects.toThrow('repo-scoped installation token');
  });

  test('falls back to the project git proxy when the token export is refused (503)', async () => {
    const calls: string[] = [];
    const plan = await resolveManagedPushPlan(
      failingClient(503, 'Managed git push token export requires a repo-scoped installation token', calls),
      managed(),
      'kortix-jwt',
    );

    expect(calls).toEqual(['/projects/proj_1/git-token']);
    expect(plan).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      pushToken: 'kortix-jwt',
      pushUsername: 'x-access-token',
      viaProxy: true,
    });
  });

  test('falls back on 409 (project not managed by an App-backed remote)', async () => {
    const plan = await resolveManagedPushPlan(
      failingClient(409, 'Project is not a managed repo'),
      managed(),
      'kortix-jwt',
    );
    expect(plan.viaProxy).toBe(true);
  });

  test('prefers a minted repo-scoped token over the proxy', async () => {
    const client = {
      post: async <T>() =>
        ({ push_token: 'ghs_app_token', git_username: 'x-access-token', repo_id: 'r', repo_url: 'u' }) as T,
    } as unknown as Pick<ApiClient, 'post'>;

    const plan = await resolveManagedPushPlan(client, managed(), 'kortix-jwt');
    expect(plan).toEqual({
      repoUrl: 'https://github.com/managed-kortix/demo.git',
      pushToken: 'ghs_app_token',
      pushUsername: 'x-access-token',
      viaProxy: false,
    });
  });

  test('uses the provision-response token without a second round trip', async () => {
    const calls: string[] = [];
    const plan = await resolveManagedPushPlan(
      failingClient(503, 'should not be called', calls),
      managed(),
      'kortix-jwt',
      { pushToken: 'ghs_from_provision', pushUsername: 'x-access-token' },
    );
    expect(calls).toEqual([]);
    expect(plan.pushToken).toBe('ghs_from_provision');
    expect(plan.viaProxy).toBe(false);
  });

  test('rethrows when there is no proxy origin to fall back to', async () => {
    await expect(
      resolveManagedPushPlan(
        failingClient(503, 'no token'),
        { project_id: 'proj_1', repo_url: 'https://github.com/managed-kortix/demo.git' },
        'kortix-jwt',
      ),
    ).rejects.toThrow('no token');
  });

  test('rethrows non-recoverable errors (401) even when a proxy exists', async () => {
    await expect(
      resolveManagedPushPlan(failingClient(401, 'Token rejected'), managed(), 'kortix-jwt'),
    ).rejects.toThrow('Token rejected');
  });

  test('never exports a server-global PAT: the fallback credential is the caller token', async () => {
    const plan = await resolveManagedPushPlan(
      failingClient(503, 'pat'),
      managed(),
      'kortix-jwt',
    );
    expect(plan.pushToken).toBe('kortix-jwt');
    expect(plan.repoUrl).toStartWith('https://api.kortix.com/v1/git/');
  });

  test('proxy fallback resolver ignores non-proxy origins', () => {
    expect(resolveManagedProxyFallback({ git_origin_url: null })).toBeNull();
    expect(
      resolveManagedProxyFallback({ git_origin_url: 'https://github.com/acme/demo.git' }),
    ).toBeNull();
    expect(
      resolveManagedProxyFallback({ git_origin_url: 'https://api.kortix.com/v1/git/p.git' }),
    ).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/p.git',
      credentialMode: 'kortix-token',
    });
  });

  test('classifies which failures are recoverable', () => {
    expect(isManagedTokenExportUnavailable(new ApiError(503, 'x'))).toBe(true);
    expect(isManagedTokenExportUnavailable(new ApiError(409, 'x'))).toBe(true);
    expect(isManagedTokenExportUnavailable(new ApiError(401, 'x'))).toBe(false);
    expect(isManagedTokenExportUnavailable(new ApiError(500, 'x'))).toBe(false);
    expect(isManagedTokenExportUnavailable(new Error('boom'))).toBe(false);
  });
});

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
    const target = resolveExistingShipGitTarget(
      project({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
    );

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
