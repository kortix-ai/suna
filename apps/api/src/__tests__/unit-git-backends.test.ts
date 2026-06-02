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
});

describe('basicAuthHeader', () => {
  test('encodes x-access-token:<token>', () => {
    const h = basicAuthHeader('tok123');
    expect(h.Authorization).toBe(`Basic ${Buffer.from('x-access-token:tok123').toString('base64')}`);
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
