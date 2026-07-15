// Companion to managed-github-app.test.ts, split out because `hasDatabase`
// must be fixed for the lifetime of the file (see that file's header comment
// for why bun's `mock.module` can't toggle a bare/getter-exposed primitive
// between tests) — this file covers the `hasDatabase: false` self-host case
// (no DATABASE_URL configured) instead of toggling it.
import { describe, expect, mock, test } from 'bun:test';

mock.module('../../shared/db', () => ({
  hasDatabase: false,
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    }),
  },
}));

const { managedGithubAppConfig, refreshManagedGithubAppConfig, updateManagedGithubAppConfig } = await import(
  './managed-github-app'
);

describe('managed-github-app with no DB configured', () => {
  test('refreshManagedGithubAppConfig resolves to an empty config (callers fall back to env)', async () => {
    await refreshManagedGithubAppConfig();
    expect(managedGithubAppConfig()).toEqual({});
  });

  test('updateManagedGithubAppConfig throws a clear error rather than silently no-op-ing', async () => {
    await expect(updateManagedGithubAppConfig({ appId: '1' })).rejects.toThrow(/Database not configured/);
  });
});
