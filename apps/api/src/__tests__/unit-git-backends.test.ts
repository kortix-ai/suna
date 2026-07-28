/**
 * Unit tests for the provider-agnostic git backend seam: the registry, default
 * selection, and each backend's pure `buildUpstream` (URL + auth-header
 * formatting). No DB / network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  basicAuthHeader,
  getBackend,
  getDefaultManagedBackend,
  getDefaultManagedProvider,
  createGithubBackend,
  githubBackend,
  hasBackend,
  parseBasicAuthHeader,
  type GitConnectionRef,
} from '../projects/git-backends';

function ref(overrides: Partial<GitConnectionRef>): GitConnectionRef {
  return {
    provider: 'github',
    upstreamUrl: 'https://github.com/kortix-managed/demo.git',
    externalRepoId: '123',
    repoOwner: 'kortix-managed',
    repoName: 'demo',
    installationId: '999',
    credentialRef: null,
    defaultBranch: 'main',
    managed: true,
    metadata: {},
    ...overrides,
  };
}

const ORIG_PROVIDER = process.env.MANAGED_GIT_PROVIDER;
afterEach(() => {
  if (ORIG_PROVIDER === undefined) delete process.env.MANAGED_GIT_PROVIDER;
  else process.env.MANAGED_GIT_PROVIDER = ORIG_PROVIDER;
});

describe('registry', () => {
  test('resolves known providers', () => {
    expect(getBackend('github')).toBe(githubBackend);
    expect(hasBackend('github')).toBe(true);
    expect(hasBackend('bitbucket')).toBe(false);
    expect(hasBackend('forgejo')).toBe(false);
  });

  test('unknown providers fall back to the github backend (generic basic-auth transport)', () => {
    expect(getBackend('gitlab')).toBe(githubBackend);
    expect(getBackend('generic')).toBe(githubBackend);
    expect(getBackend('bitbucket')).toBe(githubBackend);
  });

  test('default managed backend is github (and honours MANAGED_GIT_PROVIDER)', () => {
    delete process.env.MANAGED_GIT_PROVIDER;
    expect(getDefaultManagedProvider()).toBe('github');
    expect(getDefaultManagedBackend()).toBe(githubBackend);
    process.env.MANAGED_GIT_PROVIDER = 'github';
    expect(getDefaultManagedProvider()).toBe('github');
    expect(getDefaultManagedBackend()).toBe(githubBackend);
  });

  test('default managed provider ignores dotenvx ciphertext', () => {
    process.env.MANAGED_GIT_PROVIDER = 'encrypted:provider';
    expect(getDefaultManagedProvider()).toBe('github');
    expect(getDefaultManagedBackend()).toBe(githubBackend);
  });
});

describe('basicAuthHeader', () => {
  test('encodes x-access-token:<token>', () => {
    const h = basicAuthHeader('tok123');
    expect(h.Authorization).toBe(
      `Basic ${Buffer.from('x-access-token:tok123').toString('base64')}`,
    );
  });

  test('parses a provider-selected basic username and token', () => {
    const encoded = Buffer.from('t:code-storage-jwt').toString('base64');
    expect(parseBasicAuthHeader(`Basic ${encoded}`)).toEqual({
      username: 't',
      token: 'code-storage-jwt',
    });
  });
});

describe('buildUpstream', () => {
  test('github: upstream url + basic auth header', () => {
    const up = githubBackend.buildUpstream(ref({}), 'ghs_abc', 'write');
    expect(up.url).toBe('https://github.com/kortix-managed/demo.git');
    expect(up.headers.Authorization).toBe(
      `Basic ${Buffer.from('x-access-token:ghs_abc').toString('base64')}`,
    );
  });

  test('github: no token → no auth header (anon)', () => {
    const up = githubBackend.buildUpstream(ref({}), null, 'read');
    expect(up.headers.Authorization).toBeUndefined();
  });

  test('generic/BYO (github fallback): uses upstreamUrl verbatim + basic auth', () => {
    const up = getBackend('generic').buildUpstream(
      ref({
        provider: 'generic',
        upstreamUrl: 'https://example.com/org/repo.git',
        repoOwner: 'org',
        repoName: 'repo',
      }),
      'tok',
      'read',
    );
    expect(up.url).toBe('https://example.com/org/repo.git');
    expect(up.headers.Authorization).toBe(
      `Basic ${Buffer.from('x-access-token:tok').toString('base64')}`,
    );
  });
});

describe('managed GitHub Nango backend', () => {
  function fixture(mode: 'nango_preferred' | 'nango_only' = 'nango_only') {
    const calls: string[] = [];
    let nangoError: Error | null = null;
    const backend = createGithubBackend({
      credentialMode: () => mode,
      resolveManagedCredential: async () => {
        calls.push('resolve:nango');
        if (nangoError) throw nangoError;
        return {
          connectionId: 'managed-nango-connection',
          installationId: '999',
          owner: 'kortix-managed',
          ownerType: 'Organization',
          token: 'nango-installation-token',
        };
      },
      legacyConfigured: async () => true,
      resolveLegacyAdminAuth: async () => {
        calls.push('resolve:legacy');
        return {
          token: 'legacy-token',
          source: 'app_installation',
          owner: 'legacy-owner',
          ownerType: 'Organization',
          installationId: '777',
        };
      },
      mintLegacyWriteToken: async () => {
        calls.push('mint:legacy');
        return 'legacy-write-token';
      },
      createRepo: async (input) => {
        calls.push(`create:${input.owner}:${input.auth?.source}`);
        return {
          id: 42,
          name: input.name,
          full_name: `${input.owner}/${input.name}`,
          private: true,
          html_url: `https://github.com/${input.owner}/${input.name}`,
          clone_url: `https://github.com/${input.owner}/${input.name}.git`,
          ssh_url: `git@github.com:${input.owner}/${input.name}.git`,
          default_branch: 'main',
          description: null,
        };
      },
      deleteRepo: async ({ owner, repo, auth }) => {
        calls.push(`delete:${owner}/${repo}:${auth.source}`);
      },
      addCollaborator: async ({ owner, repo, username, auth }) => {
        calls.push(`invite:${owner}/${repo}:${username}:${auth.source}`);
        return { html_url: 'https://github.com/invitation/1' };
      },
      seedRepo: async ({ token }) => {
        calls.push(`seed:${token}`);
      },
    });
    return {
      backend,
      calls,
      setNangoError(error: Error | null) {
        nangoError = error;
      },
    };
  }

  test('creates a repository with the selected Nango connection and persists its reference', async () => {
    const { backend, calls } = fixture();
    const repo = await backend.createRepo({
      accountId: 'account-1',
      projectId: 'project-1',
      slug: 'demo',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(repo).toMatchObject({
      repoOwner: 'kortix-managed',
      installationId: '999',
      credentialRef: 'managed-nango-connection',
      initialToken: null,
    });
    expect(calls).toEqual(['resolve:nango', 'create:kortix-managed:nango']);
  });

  test('resolves a fresh selected Nango credential for delete, collaborator, and external push', async () => {
    const { backend, calls } = fixture();
    const managedRef = ref({ credentialRef: 'managed-nango-connection' });

    await backend.deleteRepo(managedRef);
    await backend.inviteCollaborator?.(managedRef, 'octocat', 'write');
    const pushUrl = await backend.authedPushUrl?.(managedRef);

    expect(calls).toEqual([
      'resolve:nango',
      'delete:kortix-managed/demo:nango',
      'resolve:nango',
      'invite:kortix-managed/demo:octocat:nango',
      'resolve:nango',
    ]);
    expect(pushUrl).toContain('x-access-token:nango-installation-token@github.com');
  });

  test('does not use legacy credentials in nango_only mode', async () => {
    const fixtureState = fixture('nango_only');
    fixtureState.setNangoError(new Error('Nango unavailable'));

    await expect(
      fixtureState.backend.createRepo({
        accountId: 'account-1',
        projectId: 'project-1',
        slug: 'demo',
        defaultBranch: 'main',
        isPrivate: true,
      }),
    ).rejects.toThrow('Nango unavailable');
    expect(fixtureState.calls).toEqual(['resolve:nango']);
  });

  test('uses legacy credentials only in nango_preferred mode', async () => {
    const fixtureState = fixture('nango_preferred');
    fixtureState.setNangoError(new Error('Nango unavailable'));

    const repo = await fixtureState.backend.createRepo({
      accountId: 'account-1',
      projectId: 'project-1',
      slug: 'demo',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(repo).toMatchObject({
      repoOwner: 'legacy-owner',
      installationId: '777',
      credentialRef: null,
    });
    expect(fixtureState.calls).toEqual([
      'resolve:nango',
      'resolve:legacy',
      'create:legacy-owner:app_installation',
    ]);
  });
});
