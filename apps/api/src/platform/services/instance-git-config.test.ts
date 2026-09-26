/**
 * The two resolvers behind every managed-git decision, and the mutability gate
 * derived from them.
 *
 * The rule they encode was paid for on 2026-09-16: one stored row shadowed six
 * env values field by field, so production signed as a brand-new App while
 * still holding the old App's installations and the old owner's token. A
 * config is resolved WHOLE, from ONE source, or not at all.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  __setStoredAppIdentityForTests,
  appIdentityEnvOwners,
  resolveAppIdentity,
} from './github-app-identity';
import {
  __resetGitBackendRefusalLogForTests,
  __setStoredGitBackendForTests,
  gitBackendEnvOwners,
  resolveGitBackend,
} from './managed-git-backend';
import { resolveInstanceGitMutability } from './instance-git-mutability';

const ENV_KEYS = [
  'KORTIX_GITHUB_APP_ID',
  'GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'KORTIX_GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_ID',
  'KORTIX_GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_CLIENT_SECRET',
  'KORTIX_GITHUB_APP_SLUG',
  'GITHUB_APP_SLUG',
  'KORTIX_GITHUB_APP_STATE_SECRET',
  'KORTIX_GITHUB_APP_WEBHOOK_SECRET',
  'GITHUB_APP_WEBHOOK_SECRET',
  'MANAGED_GIT_GITHUB_OWNER',
  'MANAGED_GIT_GITHUB_TOKEN',
  'MANAGED_GIT_GITHUB_INSTALL_ID',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  __setStoredAppIdentityForTests({});
  __setStoredGitBackendForTests({});
  __resetGitBackendRefusalLogForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// A PEM-shaped fixture with NO contiguous marker literal in source: the armor
// lines are assembled at runtime so the secret scanner (gitleaks `private-key`)
// never sees `-----BEGIN … PRIVATE KEY-----` as one token. The resolvers only
// check the value is non-empty; nothing here is a key.
const ARMOR = (kind: 'BEGIN' | 'END') => ['-----', kind, ' RSA PRIVATE KEY', '-----'].join('');
const fakePem = (body: string) => `${ARMOR('BEGIN')}${body}${ARMOR('END')}`;

const DB_IDENTITY = {
  appId: '4968692',
  privateKey: fakePem('db'),
  clientId: 'Iv1.db',
  clientSecret: 'db-secret',
  webhookSecret: 'db-webhook',
  stateSecret: 'db-state',
  slug: 'kortix-self-host-05804762',
};

describe('resolveAppIdentity — whole config, one source', () => {
  test('env wins ENTIRELY, even with a full stored row present', () => {
    process.env.KORTIX_GITHUB_APP_ID = '3812697';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = fakePem('env');
    process.env.KORTIX_GITHUB_APP_CLIENT_ID = 'Iv1.env';
    process.env.KORTIX_GITHUB_APP_CLIENT_SECRET = 'env-secret';
    __setStoredAppIdentityForTests(DB_IDENTITY);

    const identity = resolveAppIdentity();

    expect(identity?.source).toBe('env');
    expect(identity?.appId).toBe('3812697');
    expect(identity?.clientId).toBe('Iv1.env');
    expect(identity?.clientSecret).toBe('env-secret');
    // The exact mix that broke production: an env appId must never be paired
    // with a stored client id, slug, or state secret.
    expect(identity?.configuredSlug).toBeNull();
    expect(identity?.stateSecret).toBeNull();
  });

  test('a complete stored row resolves when env has none', () => {
    __setStoredAppIdentityForTests(DB_IDENTITY);

    const identity = resolveAppIdentity();

    expect(identity?.source).toBe('db');
    expect(identity?.appId).toBe('4968692');
    expect(identity?.clientId).toBe('Iv1.db');
    expect(identity?.configuredSlug).toBe('kortix-self-host-05804762');
  });

  test('an env appId without a private key never completes from the database', () => {
    process.env.KORTIX_GITHUB_APP_ID = '3812697';
    __setStoredAppIdentityForTests(DB_IDENTITY);

    const identity = resolveAppIdentity();

    // The stored row is complete, so it resolves WHOLE — the lone env appId is
    // not half of an identity and is never mixed in.
    expect(identity?.source).toBe('db');
    expect(identity?.appId).toBe('4968692');
  });

  test('an incomplete stored row resolves to null', () => {
    __setStoredAppIdentityForTests({ appId: '4968692' });
    expect(resolveAppIdentity()).toBeNull();
  });

  test('no configuration at all resolves to null', () => {
    expect(resolveAppIdentity()).toBeNull();
  });

  test('names the env variables that own the identity', () => {
    process.env.GITHUB_APP_ID = '3812697';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = 'pem';
    expect(appIdentityEnvOwners()).toEqual([
      'GITHUB_APP_ID',
      'KORTIX_GITHUB_APP_PRIVATE_KEY',
    ]);
  });
});

describe('resolveGitBackend — a stored owner never pairs with an env token', () => {
  test('a complete env token pair resolves as env', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'ghp_env';

    const backend = resolveGitBackend();

    expect(backend).toEqual({
      source: 'env',
      kind: 'pat',
      owner: 'managed-kortix',
      token: 'ghp_env',
    });
  });

  test('a complete env App pair resolves as env', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
    process.env.MANAGED_GIT_GITHUB_INSTALL_ID = '140097279';

    expect(resolveGitBackend()).toEqual({
      source: 'env',
      kind: 'app',
      owner: 'managed-kortix',
      ownerType: null,
      installationId: '140097279',
    });
  });

  // Production, 2026-09-16 → 2026-09-20: the token AND the installation id were
  // both set. The token won silently, it could not create a repository, and the
  // App that could was never consulted. Every project creation failed for days.
  test('a token set beside an installation id still wins, and says the App is ignored', () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(' '));
    try {
      process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
      process.env.MANAGED_GIT_GITHUB_TOKEN = 'github_pat_env';
      process.env.MANAGED_GIT_GITHUB_INSTALL_ID = '140097279';

      expect(resolveGitBackend()?.kind).toBe('pat');
      resolveGitBackend();

      const ambiguity = errors.filter((line) => line.includes('MANAGED_GIT_GITHUB_INSTALL_ID'));
      expect(ambiguity).toHaveLength(1);
      expect(ambiguity[0]).toContain('MANAGED_GIT_GITHUB_TOKEN');
      expect(ambiguity[0]).toContain('ignored');
    } finally {
      console.error = realError;
    }
  });

  test('an EMPTY token beside an installation id selects the App', () => {
    // The supported way to switch a deployment to the App without removing a
    // key its task definition may reference by name.
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
    process.env.MANAGED_GIT_GITHUB_TOKEN = '   ';
    process.env.MANAGED_GIT_GITHUB_INSTALL_ID = '140097279';

    expect(resolveGitBackend()).toEqual({
      source: 'env',
      kind: 'app',
      owner: 'managed-kortix',
      ownerType: null,
      installationId: '140097279',
    });
  });

  test('env wins entirely over a complete stored row', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'ghp_env';
    __setStoredGitBackendForTests({
      kind: 'app',
      owner: 'kortix-ai',
      ownerType: 'Organization',
      installationId: '99',
    });

    const backend = resolveGitBackend();

    expect(backend?.source).toBe('env');
    expect(backend?.owner).toBe('managed-kortix');
  });

  test('a stored owner with only an env token resolves to null, with a reason', () => {
    // THE INCIDENT, reduced: the database held the owner, the environment held
    // the token, and the old resolver returned the two together.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      process.env.MANAGED_GIT_GITHUB_TOKEN = 'ghp_env';
      __setStoredGitBackendForTests({ kind: 'app', owner: 'kortix-ai', installationId: '99' });

      expect(resolveGitBackend()).toBeNull();
      expect(warnings.join('\n')).toContain('refusing a partial configuration');
      expect(warnings.join('\n')).toContain('MANAGED_GIT_GITHUB_OWNER');
    } finally {
      console.warn = realWarn;
    }
  });

  test('a complete stored row resolves when env is silent', () => {
    __setStoredGitBackendForTests({
      kind: 'app',
      owner: 'kortix-ai',
      ownerType: 'User',
      installationId: '99',
    });

    expect(resolveGitBackend()).toEqual({
      source: 'db',
      kind: 'app',
      owner: 'kortix-ai',
      ownerType: 'User',
      installationId: '99',
    });
  });

  test('an incomplete stored row resolves to null', () => {
    __setStoredGitBackendForTests({ kind: 'pat', owner: 'kortix-ai' });
    expect(resolveGitBackend()).toBeNull();
  });

  test('names the env variables that own the backend', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'ghp_env';
    expect(gitBackendEnvOwners()).toEqual([
      'MANAGED_GIT_GITHUB_OWNER',
      'MANAGED_GIT_GITHUB_TOKEN',
    ]);
  });
});

describe('resolveInstanceGitMutability', () => {
  test('an env-managed instance is immutable and names its owners', () => {
    process.env.KORTIX_GITHUB_APP_ID = '3812697';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = 'pem';
    process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'ghp_env';

    expect(resolveInstanceGitMutability()).toEqual({
      mutable: false,
      envOwnedBy: [
        'KORTIX_GITHUB_APP_ID',
        'KORTIX_GITHUB_APP_PRIVATE_KEY',
        'MANAGED_GIT_GITHUB_OWNER',
        'MANAGED_GIT_GITHUB_TOKEN',
      ],
    });
  });

  test('one env half is enough to make the whole instance immutable', () => {
    process.env.KORTIX_GITHUB_APP_ID = '3812697';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = 'pem';

    const mutability = resolveInstanceGitMutability();

    expect(mutability.mutable).toBe(false);
    expect(mutability.envOwnedBy).toEqual([
      'KORTIX_GITHUB_APP_ID',
      'KORTIX_GITHUB_APP_PRIVATE_KEY',
    ]);
  });

  test('a null half is mutable, not env-owned', () => {
    __setStoredAppIdentityForTests(DB_IDENTITY);

    expect(resolveInstanceGitMutability()).toEqual({ mutable: true, envOwnedBy: [] });
  });

  test('an unconfigured instance is mutable', () => {
    expect(resolveInstanceGitMutability()).toEqual({ mutable: true, envOwnedBy: [] });
  });
});
