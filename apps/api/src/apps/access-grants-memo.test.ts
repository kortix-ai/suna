import { describe, expect, mock, test } from 'bun:test';
import { runWithContext } from '../lib/request-context';

/**
 * `loadAppAccessGrantsFor` is request-memoized. The Apps list calls it
 * back-to-back with the SAME rows — once inside `filterAppsVisibleToUser`, once
 * inside `appsOpenableByUser` (KRTX-2341: the second call re-read the identical
 * grants only to compute a second predicate over identical data, one more
 * statement on a pool that was already queueing during the 2026-10-14/15
 * saturation burst). The memo must stay REQUEST-scoped — every request still
 * reads fresh — and an empty id list must never reach the db at all.
 */

interface GrantRow {
  appId: string;
  principalType: string;
  principalId: string;
}

let dbReads = 0;
let grantRows: GrantRow[] = [];

const realDbModule = await import('../shared/db');
mock.module('../shared/db', () => ({
  ...realDbModule,
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          dbReads += 1;
          return Promise.resolve(grantRows);
        },
      }),
    }),
  },
}));

const { loadAppAccessGrantsFor } = await import('./access');

const APP_1 = '11111111-1111-4111-8111-111111111111';
const APP_2 = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';

describe('loadAppAccessGrantsFor request memo', () => {
  test('one read per request for repeated id sets — in any order', async () => {
    grantRows = [{ appId: APP_1, principalType: 'member', principalId: MEMBER }];
    dbReads = 0;
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      const first = await loadAppAccessGrantsFor([APP_1, APP_2]);
      const second = await loadAppAccessGrantsFor([APP_2, APP_1]); // same set, different order
      expect(second).toBe(first); // same request, same resolution
      expect(second.get(APP_1)).toEqual([{ principalType: 'member', principalId: MEMBER }]);
      expect(second.has(APP_2)).toBe(false); // apps with no grant rows are absent, callers default to []
    });
    expect(dbReads).toBe(1); // the regression: 2 before the memo
  });

  test('a different id set in the same request reads again', async () => {
    grantRows = [{ appId: APP_1, principalType: 'member', principalId: MEMBER }];
    dbReads = 0;
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      await loadAppAccessGrantsFor([APP_1]);
      await loadAppAccessGrantsFor([APP_1, APP_2]);
    });
    expect(dbReads).toBe(2);
  });

  test('a new request reads fresh', async () => {
    dbReads = 0;
    grantRows = [];
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      await loadAppAccessGrantsFor([APP_1]);
    });
    grantRows = [{ appId: APP_1, principalType: 'group', principalId: 'g1' }];
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      const map = await loadAppAccessGrantsFor([APP_1]);
      expect(map.get(APP_1)).toEqual([{ principalType: 'group', principalId: 'g1' }]);
    });
    expect(dbReads).toBe(2);
  });

  test('an empty id list never reaches the db — memoized or not', async () => {
    dbReads = 0;
    grantRows = [];
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      const empty = await loadAppAccessGrantsFor([]);
      expect(empty.size).toBe(0);
      await loadAppAccessGrantsFor([]);
    });
    expect(dbReads).toBe(0);
  });

  test('outside a request scope there is no memo — every call reads', async () => {
    grantRows = [{ appId: APP_1, principalType: 'member', principalId: MEMBER }];
    dbReads = 0;
    await loadAppAccessGrantsFor([APP_1]);
    await loadAppAccessGrantsFor([APP_1]);
    expect(dbReads).toBe(2);
  });
});
