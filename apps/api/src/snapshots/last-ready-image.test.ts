import { describe, expect, test } from 'bun:test';
import { findServableLastReadyImage } from './builder';
import { type ReadyImage, lastReadyImageCandidates } from './last-ready-image';

const identity = { snapshotName: 'kortix-tpl-NEW' };
const template = {
  slug: 'default',
  isShared: true,
  providerSnapshotName: 'kortix-tpl-OLD',
  contentHash: 'hash-old',
};
const project = { projectId: 'p-1' };

function fakeProvider(active: readonly string[], opts: { throwOn?: string } = {}) {
  const asked: string[] = [];
  return {
    asked,
    getSnapshotState: async (name: string) => {
      asked.push(name);
      if (opts.throwOn === name) throw new Error('provider blip');
      return active.includes(name) ? ('active' as const) : ('missing' as const);
    },
  };
}

const noHistory = async () => [] as ReadyImage[];

describe('lastReadyImageCandidates', () => {
  test('the row-recorded image is offered before build history', () => {
    expect(
      lastReadyImageCandidates({
        recordedSnapshotName: 'kortix-tpl-OLD',
        recordedContentHash: 'hash-old',
        history: [{ snapshotName: 'kortix-tpl-OLDER', contentHash: 'hash-older' }],
        identitySnapshotName: 'kortix-tpl-NEW',
      }),
    ).toEqual([
      { snapshotName: 'kortix-tpl-OLD', contentHash: 'hash-old' },
      { snapshotName: 'kortix-tpl-OLDER', contentHash: 'hash-older' },
    ]);
  });

  test('the identity being built is never offered back to itself', () => {
    expect(
      lastReadyImageCandidates({
        recordedSnapshotName: 'kortix-tpl-NEW',
        history: [
          { snapshotName: 'kortix-tpl-NEW', contentHash: 'h' },
          { snapshotName: 'kortix-tpl-OLD', contentHash: 'hash-old' },
        ],
        identitySnapshotName: 'kortix-tpl-NEW',
      }),
    ).toEqual([{ snapshotName: 'kortix-tpl-OLD', contentHash: 'hash-old' }]);
  });

  test('duplicates collapse and the candidate set stays bounded', () => {
    const candidates = lastReadyImageCandidates({
      recordedSnapshotName: 'a',
      history: [
        { snapshotName: 'a', contentHash: null },
        { snapshotName: 'b', contentHash: null },
        { snapshotName: 'c', contentHash: null },
        { snapshotName: 'd', contentHash: null },
      ],
      identitySnapshotName: 'z',
      limit: 3,
    });
    expect(candidates.map((c) => c.snapshotName)).toEqual(['a', 'b', 'c']);
  });

  test('a template that never shipped an image has no candidates', () => {
    expect(
      lastReadyImageCandidates({
        recordedSnapshotName: null,
        history: [],
        identitySnapshotName: 'kortix-tpl-FIRST',
      }),
    ).toEqual([]);
  });
});

describe('findServableLastReadyImage — a session boot never waits for a build', () => {
  test('serves the predecessor while the new identity is still building', async () => {
    const provider = fakeProvider(['kortix-tpl-OLD']);
    const servable = await findServableLastReadyImage(provider, {
      project,
      template,
      identity,
      buildProvider: 'e2b',
      readHistory: noHistory,
    });
    expect(servable).toEqual({ snapshotName: 'kortix-tpl-OLD', contentHash: 'hash-old' });
    expect(provider.asked).not.toContain('kortix-tpl-NEW');
  });

  test('falls back to build history when the row-recorded image is gone', async () => {
    const provider = fakeProvider(['kortix-tpl-OLDER']);
    const servable = await findServableLastReadyImage(provider, {
      project,
      template,
      identity,
      buildProvider: 'e2b',
      readHistory: async () => [{ snapshotName: 'kortix-tpl-OLDER', contentHash: 'hash-older' }],
    });
    expect(servable).toEqual({ snapshotName: 'kortix-tpl-OLDER', contentHash: 'hash-older' });
  });

  test('a genuinely FIRST build has nothing to serve and must block', async () => {
    const provider = fakeProvider([]);
    expect(
      await findServableLastReadyImage(provider, {
        project,
        template: { ...template, providerSnapshotName: null, contentHash: null },
        identity,
        buildProvider: 'e2b',
        readHistory: noHistory,
      }),
    ).toBeNull();
  });

  test('a provider read failure falls through to the build path instead of failing the boot', async () => {
    const provider = fakeProvider(['kortix-tpl-OLD'], { throwOn: 'kortix-tpl-OLD' });
    expect(
      await findServableLastReadyImage(provider, {
        project,
        template,
        identity,
        buildProvider: 'e2b',
        readHistory: noHistory,
      }),
    ).toBeNull();
  });

  test('a history read failure is survivable — the row-recorded image still serves', async () => {
    const provider = fakeProvider(['kortix-tpl-OLD']);
    const servable = await findServableLastReadyImage(provider, {
      project,
      template,
      identity,
      buildProvider: 'e2b',
      readHistory: async () => {
        throw new Error('db down');
      },
    });
    expect(servable?.snapshotName).toBe('kortix-tpl-OLD');
  });
});
