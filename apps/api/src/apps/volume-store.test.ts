import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: Array<{ method: string; path: string; body?: string }> = [];
let commitStatus = 200;
mock.module('../shared/platinum', () => ({
  platinumFetch: async (path: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', path, body: init.body as string | undefined });
    if (path.endsWith('/commit')) {
      return commitStatus === 200
        ? Response.json({ commit_id: 'cmt_live', head_commit_id: 'cmt_live', commits: [] })
        : Response.json({ code: 'commit_failed' }, { status: commitStatus });
    }
    if (path.includes('/tags/')) return Response.json({ name: 'daily-20261014', commit_id: 'cmt_live', created_at: '2026-10-14T00:00:00Z' });
    return Response.json({ size_limit_bytes: 100 * 1024 ** 3, logical_bytes: 1_000_000, last_commit_at: '2026-10-14T16:00:00.000Z' });
  },
}));

const { appVolumeStore, AppVolumeStoreError } = await import('./volume-store');

describe('appVolumeStore', () => {
  beforeEach(() => {
    calls.length = 0;
    commitStatus = 200;
  });

  test('a snapshot commits the live mount first, then tags exactly that commit (never a stale head)', async () => {
    const tag = await appVolumeStore.tag('kapp-dev-v1', 'daily-20261014');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/volumes/kapp-dev-v1/commit',
      'PUT /v1/volumes/kapp-dev-v1/tags/daily-20261014',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ commit: 'cmt_live' });
    expect(tag.commit_id).toBe('cmt_live');
  });

  test('a commit that fails leaves no tag behind (the daily pass retries)', async () => {
    commitStatus = 503;
    await expect(appVolumeStore.tag('kapp-dev-v1', 'daily-20261014')).rejects.toBeInstanceOf(AppVolumeStoreError);
    expect(calls.map((call) => call.method)).toEqual(['POST']);
  });

  test('info reads the size Platinum allots, the bytes in use and the last commit', async () => {
    expect(await appVolumeStore.info('kapp-dev-v1')).toEqual({
      size_gb: 100,
      used_bytes: 1_000_000,
      last_commit_at: '2026-10-14T16:00:00.000Z',
    });
    expect(calls).toEqual([{ method: 'GET', path: '/v1/volumes/kapp-dev-v1', body: undefined }]);
  });
});
