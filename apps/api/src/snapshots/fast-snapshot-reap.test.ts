import { describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');

const { config } = await import('../config');
const { fastSnapshotName, reapSupersededFastSnapshots } = await import('./builder');

function fakeProvider(names: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    listSnapshots: async () => names.map((name) => ({ name })),
    deleteSnapshot: async (name: string) => {
      deleted.push(name);
    },
  };
}

describe('fast snapshot lifecycle', () => {
  test('names the image per environment and fingerprint', () => {
    expect(fastSnapshotName('a'.repeat(64))).toBe(
      `kortix-fast-${config.INTERNAL_KORTIX_ENV}-${'a'.repeat(16)}`,
    );
    expect(fastSnapshotName('a'.repeat(64))).not.toBe(fastSnapshotName('b'.repeat(64)));
  });

  test('reaps only superseded fast images from the same environment', async () => {
    const keep = fastSnapshotName('b'.repeat(64));
    const stale = fastSnapshotName('a'.repeat(64));
    const foreign = `kortix-fast-prod-${'c'.repeat(16)}`;
    const standard = `kortix-default-${'d'.repeat(12)}`;
    const provider = fakeProvider([keep, stale, foreign, standard]);

    await reapSupersededFastSnapshots(provider, keep, async () => new Set());

    expect(provider.deleted).toEqual([stale]);
  });

  test('fails closed when recent-build protection is unavailable', async () => {
    const keep = fastSnapshotName('b'.repeat(64));
    const stale = fastSnapshotName('a'.repeat(64));
    const provider = fakeProvider([keep, stale]);

    await reapSupersededFastSnapshots(provider, keep, async () => {
      throw new Error('database unavailable');
    });

    expect(provider.deleted).toEqual([]);
  });
});
