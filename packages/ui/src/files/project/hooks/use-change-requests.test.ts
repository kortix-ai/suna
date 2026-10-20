import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChangeRequest } from '../api/change-requests';
import { findCachedChangeRequest, type CachedListEntry } from './use-change-requests';

/**
 * Opening a proposed change used to cost two SERIAL round trips before its
 * merge button worked:
 *
 *   1. `GET /change-requests/:id` — whose entire body is `{ change_request }`,
 *      i.e. the very object the list response already held.
 *   2. `GET .../merge-preview` — which could not even START until (1) landed,
 *      because the dialog gates it on `status === 'open'`.
 *
 * Seeding the detail cache from the list collapses both: the header paints on
 * the click frame and the preview fires in parallel. These tests pin the
 * lookup that makes that possible.
 */
function cr(id: string, extra: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    cr_id: id,
    number: 1,
    title: `CR ${id}`,
    status: 'open',
    base_ref: 'main',
    head_ref: 'feat',
    created_at: new Date().toISOString(),
    ...extra,
  } as ChangeRequest;
}

const entry = (key: readonly unknown[], rows: ChangeRequest[] | undefined): CachedListEntry => [
  key,
  rows ? { change_requests: rows } : undefined,
];

describe('findCachedChangeRequest', () => {
  test('finds a change request in the only cached bucket', () => {
    const target = cr('a');
    const hit = findCachedChangeRequest([entry(['list', 'open'], [cr('z'), target])], 'a');
    expect(hit?.cr).toBe(target);
  });

  /**
   * The panel's filter decides which bucket is populated, and "All" overlaps
   * every other one — so the scan cannot assume a single list.
   */
  test('searches every status bucket, not just the first', () => {
    const target = cr('b', { status: 'merged' });
    const hit = findCachedChangeRequest(
      [
        entry(['list', 'open'], [cr('x')]),
        entry(['list', 'closed'], []),
        entry(['list', 'merged'], [target]),
      ],
      'b',
    );
    expect(hit?.cr).toBe(target);
  });

  /**
   * The caller reads `dataUpdatedAt` off the returned key to date the seed.
   * Reporting the wrong list would stamp it with another bucket's fetch time,
   * which decides whether the background refetch fires.
   */
  test('reports which bucket the row came from', () => {
    const hit = findCachedChangeRequest(
      [entry(['list', 'open'], [cr('x')]), entry(['list', 'all'], [cr('c')])],
      'c',
    );
    expect(hit?.key).toEqual(['list', 'all']);
  });

  /**
   * The Changes panel's `useInfiniteQuery` entry sits under the same list
   * scope as `{ pages, pageParams }`. A scan that read only
   * `data.change_requests` threw on it during render (KRTX-2316).
   */
  test('reads the paged panel entry and scans past it', () => {
    const paged = cr('p', { status: 'merged' });
    const target = cr('t', { status: 'closed' });
    const entries: CachedListEntry[] = [
      [
        ['list', 'merged', 'pages'],
        {
          pages: [{ change_requests: [cr('x')] }, { change_requests: [paged] }],
          pageParams: [undefined, 'c1'],
        },
      ],
      entry(['list', 'closed'], [target]),
    ];
    expect(findCachedChangeRequest(entries, 't')).toEqual({ cr: target, key: ['list', 'closed'] });
    expect(findCachedChangeRequest(entries, 'p')).toEqual({
      cr: paged,
      key: ['list', 'merged', 'pages'],
    });
  });

  test('tolerates a cache entry that has no data yet', () => {
    expect(findCachedChangeRequest([entry(['list', 'open'], undefined)], 'a')).toBeUndefined();
  });

  test('returns undefined when nothing is cached', () => {
    expect(findCachedChangeRequest([], 'a')).toBeUndefined();
  });

  test('does not match a different change request', () => {
    expect(findCachedChangeRequest([entry(['list', 'open'], [cr('a')])], 'b')).toBeUndefined();
  });

  test('an empty id never matches', () => {
    expect(findCachedChangeRequest([entry(['list', 'open'], [cr('')])], '')).toBeUndefined();
  });
});

/**
 * The count badge and both command palette reads share the `list(…, 'open')`
 * entry. One reader without the 100-row limit got the server's 50-row page and
 * wrote it over the others, so the badge dropped from 73 to 50 (KRTX-2316).
 */
describe("the shared 'open' change-request entry", () => {
  test('every reader builds it with openChangeRequestListQuery', () => {
    const src = join(import.meta.dir, '../../..');
    const owners: string[] = [];
    for (const file of new Glob('**/*.{ts,tsx}').scanSync(src)) {
      if (file.includes('.test.')) continue;
      const hits = readFileSync(join(src, file), 'utf8').match(
        /changeRequestKeys\.list\([^)]*'open'\)/g,
      );
      for (const _ of hits ?? []) owners.push(file);
    }
    expect(owners).toEqual(['files/project/hooks/use-change-requests.ts']);
  });
});
