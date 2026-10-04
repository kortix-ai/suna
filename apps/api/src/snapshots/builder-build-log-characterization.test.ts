import { expect, mock, test } from 'bun:test';

let rows: any[] = [];
const updates: Array<{ values: any }> = [];
const observations = new Map<string, string>();
const provider = 'daytona';

mock.module('../lib/config', () => ({ SANDBOX_VERSION: 'test', config: { ALLOWED_SANDBOX_PROVIDERS: [provider] } }));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async (n: number) => rows.slice(0, n) }) }) }) }),
    update: () => ({ set: (values: any) => ({ where: async () => {
      updates.push({ values });
    } }) }),
  },
}));

mock.module('./providers', () => ({
  getSandboxProvider: (id: string) => ({
    id,
    isConfigured: () => true,
    getSnapshotState: async () => observations.get(id) ?? 'missing',
  }),
}));

const { listSnapshotBuilds, reconcileStaleBuilds } = await import('./builder');

function build(id: string, metadata: unknown = { provider }) {
  return {
    buildId: id, projectId: 'project-test', branch: 'fallback', snapshotName: 'image-test',
    contentHash: 'hash-test', status: 'building', error: null, errorCategory: null,
    startedAt: new Date(0), finishedAt: null, metadata,
  };
}

test('listSnapshotBuilds maps metadata and defaults, with a bounded limit', async () => {
  rows = [build('one', { slug: 'custom', source: 'manual', provider }), build('two', { provider: 'not-allowed' })];
  expect(await listSnapshotBuilds('project-test', { limit: 0 })).toEqual([{
    buildId: 'one', projectId: 'project-test', slug: 'custom', snapshotName: 'image-test',
    contentHash: 'hash-test', status: 'building', error: null, errorCategory: null,
    source: 'manual', provider, startedAt: new Date(0), finishedAt: null,
  }]);
  const summaries = await listSnapshotBuilds('project-test');
  expect(summaries[1]).toMatchObject({ slug: 'fallback', source: null, provider: null });
});

test('reconcileStaleBuilds closes active and settled failures but leaves uncertain builds open', async () => {
  updates.length = 0;
  rows = [build('active'), build('legacy', {})];
  observations.set(provider, 'active');
  expect(await reconcileStaleBuilds({ projectId: 'project-test' })).toEqual({ checked: 2, closedReady: 1, closedFailed: 0 });
  expect(updates.map((entry) => entry.values.status)).toEqual(['ready']);

  updates.length = 0;
  rows = [build('settled')];
  observations.set(provider, 'missing');
  expect(await reconcileStaleBuilds()).toEqual({ checked: 1, closedReady: 0, closedFailed: 1 });
  expect(updates[0]!.values).toMatchObject({ status: 'failed', errorCategory: expect.any(String) });

  updates.length = 0;
  rows = [build('in-flight'), build('unattributed', {})];
  observations.set(provider, 'building');
  expect(await reconcileStaleBuilds()).toEqual({ checked: 2, closedReady: 0, closedFailed: 0 });
  expect(updates).toEqual([]);
});
