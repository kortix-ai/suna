import { describe, expect, test } from 'bun:test';

import { currentFailedSnapshotBuild, sessionTemplateBuilds } from '../snapshots/build-state';

describe('currentFailedSnapshotBuild', () => {
  test('returns the newest build when it failed', () => {
    const failed = { id: 'failed-latest', status: 'failed' as const };

    expect(
      currentFailedSnapshotBuild([failed, { id: 'ready-older', status: 'ready' as const }]),
    ).toBe(failed);
  });

  test('ignores older failed rows once a newer build is ready', () => {
    expect(
      currentFailedSnapshotBuild([
        { id: 'ready-latest', status: 'ready' as const },
        { id: 'failed-older', status: 'failed' as const },
      ]),
    ).toBeNull();
  });

  test('ignores older failed rows while a newer build is still running', () => {
    expect(
      currentFailedSnapshotBuild([
        { id: 'building-latest', status: 'building' as const },
        { id: 'failed-older', status: 'failed' as const },
      ]),
    ).toBeNull();
  });
});

describe('sessionTemplateBuilds', () => {
  test('excludes optional per-project accelerator builds', () => {
    const template = { id: 'template', slug: 'default', status: 'ready' as const };
    const accelerator = {
      id: 'accelerator',
      slug: 'default-warm',
      status: 'failed' as const,
    };

    expect(sessionTemplateBuilds([accelerator, template])).toEqual([template]);
  });

  test('keeps a custom template whose declared slug contains warm text', () => {
    const template = {
      id: 'template',
      slug: 'warm-worker',
      status: 'failed' as const,
    };

    expect(sessionTemplateBuilds([template])).toEqual([template]);
  });
});
