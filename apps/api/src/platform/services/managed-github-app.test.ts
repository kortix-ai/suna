// Unit tests for the DB-backed managed GitHub App config (kortix.platform_settings
// under key 'managed_github_app') — the store the in-app self-host GitHub App
// setup flow (routes/github-app.ts) writes into instead of `.env`.
//
// The DB is a lightweight in-memory fake (one row, keyed by `key`) so these
// run fully offline. `hasDatabase` is fixed `true` for this whole file — bun's
// `mock.module` snapshots a getter's value at first module evaluation rather
// than re-invoking it live on every read (confirmed empirically: a getter
// toggled between tests in the same file does NOT change what consumers see),
// so the "no DB configured" / "DB not configured -> throws" cases live in
// their own file (managed-github-app-unconfigured.test.ts) with `hasDatabase`
// fixed `false` instead of toggled. `row`/`selectShouldThrow` below are plain
// closure reads inside function properties (not getters), which DO stay live
// across tests — only bare/getter-exposed primitives are affected.
//
// Run this file in its own `bun test <file>` invocation — `mock.module` is
// process-global, and other suites mock the same `../../shared/db` specifier
// with different shapes (see the same caveat in ../services/session-sandbox.test.ts).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ── in-memory fake platform_settings row (mutable, reset per test) ─────────
let row: { value: unknown } | null = null;
let selectShouldThrow = false;

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (selectShouldThrow) throw new Error('DB hiccup');
            return row ? [row] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => {
          row = { value: v.value };
          return undefined;
        },
      }),
    }),
  },
}));

const {
  managedGithubAppConfig,
  refreshManagedGithubAppConfig,
  invalidateManagedGithubAppConfig,
  updateManagedGithubAppConfig,
  MANAGED_GITHUB_APP_KEY,
} = await import('./managed-github-app');

beforeEach(() => {
  row = null;
  selectShouldThrow = false;
  invalidateManagedGithubAppConfig();
});

describe('MANAGED_GITHUB_APP_KEY', () => {
  test('is the documented platform_settings key', () => {
    expect(MANAGED_GITHUB_APP_KEY).toBe('managed_github_app');
  });
});

describe('refreshManagedGithubAppConfig / managedGithubAppConfig', () => {
  test('no row yet -> empty config', async () => {
    await refreshManagedGithubAppConfig();
    expect(managedGithubAppConfig()).toEqual({});
  });

  test('DB hiccup -> empty config, does not throw', async () => {
    selectShouldThrow = true;
    await expect(refreshManagedGithubAppConfig()).resolves.toBeUndefined();
    expect(managedGithubAppConfig()).toEqual({});
  });

  test('reads a stored row back, coercing non-string/garbage fields away', async () => {
    row = {
      value: {
        appId: '12345',
        slug: 'kortix-self-host-abc',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
        owner: 'acme-corp',
        installationId: '987',
        // garbage that should be dropped, not crash parsing:
        extra: { nested: true },
        appIdButWrongType: 123,
      },
    };
    await refreshManagedGithubAppConfig();
    expect(managedGithubAppConfig()).toEqual({
      appId: '12345',
      slug: 'kortix-self-host-abc',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      owner: 'acme-corp',
      installationId: '987',
    });
  });

  test('blank-string fields are treated as absent', async () => {
    row = { value: { appId: '   ', owner: 'acme' } };
    await refreshManagedGithubAppConfig();
    expect(managedGithubAppConfig()).toEqual({ owner: 'acme' });
  });
});

describe('updateManagedGithubAppConfig', () => {
  test('merges the patch over the existing row (read-modify-write), not a clobber', async () => {
    row = { value: { owner: 'acme-corp', installationId: '987' } };
    invalidateManagedGithubAppConfig();

    const next = await updateManagedGithubAppConfig({
      appId: '12345',
      slug: 'kortix-self-host-abc',
      privateKey: 'PEM',
    });

    expect(next).toEqual({
      owner: 'acme-corp',
      installationId: '987',
      appId: '12345',
      slug: 'kortix-self-host-abc',
      privateKey: 'PEM',
    });
    // Persisted...
    expect(row?.value).toEqual(next);
    // ...and the cache reflects it immediately (no TTL wait needed).
    expect(managedGithubAppConfig()).toEqual(next);
  });

  test('a later write for the other half of the flow does not drop the first half', async () => {
    await updateManagedGithubAppConfig({ appId: '12345', slug: 'kortix-self-host-abc', privateKey: 'PEM' });
    const next = await updateManagedGithubAppConfig({ owner: 'acme-corp', installationId: '987' });

    expect(next).toEqual({
      appId: '12345',
      slug: 'kortix-self-host-abc',
      privateKey: 'PEM',
      owner: 'acme-corp',
      installationId: '987',
    });
  });
});
