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
    expect(getDefaultManagedBackend()).toBe(githubBackend);
    process.env.MANAGED_GIT_PROVIDER = 'github';
    expect(getDefaultManagedBackend()).toBe(githubBackend);
  });

  // code.storage is RETIRED as a provisioning target. The value still exists in
  // deployed env bundles (dev's `kortix-dev-env` among them), and every one of
  // them would otherwise keep minting new repos on a host we no longer want.
  // The code refuses it outright so no environment can select it by config —
  // reading and writing EXISTING code.storage repos is unaffected, since those
  // resolve per project through `getBackend(connection.provider)`.
  test('MANAGED_GIT_PROVIDER=code-storage no longer selects code.storage', () => {
    process.env.MANAGED_GIT_PROVIDER = 'code-storage';
    expect(getDefaultManagedBackend()).toBe(githubBackend);
    process.env.MANAGED_GIT_PROVIDER = ' Code-Storage ';
    expect(getDefaultManagedBackend()).toBe(githubBackend);
    process.env.MANAGED_GIT_PROVIDER = 'code_storage';
    expect(getDefaultManagedBackend()).toBe(githubBackend);
  });

  // Existing repos must keep resolving through their own backend, or every
  // manifest read on a code.storage project fails the way the retirement was
  // supposed to prevent.
  test('an existing code-storage connection still resolves its own backend', () => {
    expect(getBackend('code-storage').id).toBe('code-storage');
    expect(hasBackend('code-storage')).toBe(true);
  });
});

describe('basicAuthHeader', () => {
  test('encodes x-access-token:<token>', () => {
    const h = basicAuthHeader('tok123');
    expect(h.Authorization).toBe(`Basic ${Buffer.from('x-access-token:tok123').toString('base64')}`);
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
    expect(up.headers.Authorization).toBe(`Basic ${Buffer.from('x-access-token:ghs_abc').toString('base64')}`);
  });

  test('github: no token → no auth header (anon)', () => {
    const up = githubBackend.buildUpstream(ref({}), null, 'read');
    expect(up.headers.Authorization).toBeUndefined();
  });

  test('generic/BYO (github fallback): uses upstreamUrl verbatim + basic auth', () => {
    const up = getBackend('generic').buildUpstream(
      ref({ provider: 'generic', upstreamUrl: 'https://example.com/org/repo.git', repoOwner: 'org', repoName: 'repo' }),
      'tok',
      'read',
    );
    expect(up.url).toBe('https://example.com/org/repo.git');
    expect(up.headers.Authorization).toBe(`Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  });
});
