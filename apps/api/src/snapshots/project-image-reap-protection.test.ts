import { describe, expect, test } from 'bun:test';
import { reapOldPerProjectWarm } from './builder';
import { scopedPerProjectWarmImageName } from './ppwarm-names';

const PROJECT_ID = '11112222-3333-4444-5555-666677778888';
const SCOPE = '0123456789ab';
const BASE = 'kortix-default-1234567890ab';
const CURRENT = scopedPerProjectWarmImageName(SCOPE, PROJECT_ID, 'tip-current', BASE, 'default');
const PREDECESSOR = scopedPerProjectWarmImageName(SCOPE, PROJECT_ID, 'tip-old', BASE, 'default');

describe('scoped project image reap protection', () => {
  test('a failing recent-build lookup skips every deletion', async () => {
    const deleted: string[] = [];

    await reapOldPerProjectWarm(PROJECT_ID, CURRENT, 'platinum', {
      provider: {
        listSnapshots: async () => [{ name: CURRENT }, { name: PREDECESSOR }],
        deleteSnapshot: async (name) => {
          deleted.push(name);
        },
      },
      collectPinnedImageRefs: async () => new Set(),
      recentBuildLookup: async () => {
        throw new Error('database unavailable');
      },
    });

    expect(deleted).toEqual([]);
  });

  test('a successful lookup still reaps an unprotected predecessor', async () => {
    const deleted: string[] = [];

    await reapOldPerProjectWarm(PROJECT_ID, CURRENT, 'platinum', {
      provider: {
        listSnapshots: async () => [{ name: CURRENT }, { name: PREDECESSOR }],
        deleteSnapshot: async (name) => {
          deleted.push(name);
        },
      },
      collectPinnedImageRefs: async () => new Set(),
      recentBuildLookup: async () => new Set(),
    });

    expect(deleted).toEqual([PREDECESSOR]);
  });
});
